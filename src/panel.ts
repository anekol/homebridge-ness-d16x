// Ness D8/16 Panel accessory helper

import {
  API, CharacteristicSetCallback, CharacteristicValue,
  HAP, Logger, PlatformAccessory
} from 'homebridge'
import { ArmingState, NessClient } from 'nessclient'
import {
  AuxiliaryOutputsUpdate, BaseEvent, MiscellaneousAlarmsUpdate,
  OutputsUpdate, PanelVersionUpdate, StatusUpdate, SystemStatusEvent, ViewStateUpdate
} from 'nessclient/build/event'
import { AlarmType, EventType, Model, State } from 'nessclient/build/event-types'
import { ArmingMode, NessD16x, OutputConfig, PLUGIN_NAME, PLATFORM_NAME, ZoneConfig } from './index'
import { NessOutputsHelper } from './outputs'
import { NessZoneHelper } from './zone'

const NO_ERRORS = null
const NESS_CLIENT_UPDATE_POLL = 60 // nessclient.connect() schedules nessclient.update() for every 60 secs
const NESS_STATUS_AUXOUTPUTS = 'S18'
const NESS_STATUS_OUTPUTS = 'S15'
const NESS_STATUS_MISC_ALARMS = 'S13'
const NESS_STATUS_VERSION = 'S17'
// const NESS_STATUS_VIEW_STATE = 'S16'
const NZONES = 16

export class NessPanelHelper {
  private readonly api: API
  private readonly connect_poll = 90 // poll period in secs - NESS_CLIENT_UPDATE_POLL should be < connect_poll
  private readonly connect_retry_wait = 2 // retry wait period in secs
  private readonly connect_retry_limit = 5 // after this number of retries, give up and wait for poll
  private readonly hap: HAP
  private readonly log: Logger
  private panelState: ArmingState = ArmingState.UNKNOWN
  private last_event_received = new Date()
  private outputsHelper: NessOutputsHelper | null = null
  private zoneHelpers = new Array<NessZoneHelper>(NZONES)
  private connect_retry_count = 0

  // constructor
  constructor(
    private readonly platform: NessD16x,
    private readonly accessory: PlatformAccessory,
    private readonly verboseLog: boolean,
    private readonly nessClient: NessClient,
    private readonly keypadCode: string,
    private readonly excludeModes: string[],
    private readonly outputs: OutputConfig[],
    private readonly zones: ZoneConfig[]
  ) {
    this.api = platform.api
    this.hap = platform.api.hap
    this.log = platform.log
  }

  // configure the main panel accessory
  public configure(): void {
    // configure NessClient event listeners
    this.nessClient.onEventReceived(this.eventReceived.bind(this))
    this.nessClient.onStateChange(this.panelStateChanged.bind(this))
    this.nessClient.onZoneChange(this.zoneChanged.bind(this))

    // configure the information service
    const info = this.accessory.getService(this.hap.Service.AccessoryInformation)
    if (info) info.setCharacteristic(this.hap.Characteristic.Manufacturer, 'Ness')

    // configure the security service
    const security = this.accessory.getService(this.hap.Service.SecuritySystem) ||
      this.accessory.addService(this.hap.Service.SecuritySystem)
    // set arbitary states and wait for status update
    this.updateSecuritySystemCurrentState(this.hap.Characteristic.SecuritySystemCurrentState.DISARMED)
    this.updateSecuritySystemTargetState(this.hap.Characteristic.SecuritySystemCurrentState.DISARMED)

    // list characteristics for debug
    if (this.verboseLog) {
      for (const c of security.characteristics) {
        this.log.info("SecuritySystem: " + c.displayName)
      }
    }

    // configure target state handler
    security.getCharacteristic(this.hap.Characteristic.SecuritySystemTargetState)
      // configure valid arming states/modes
      .setProps({ validValues: this.validArmingStates(this.excludeModes) })
      // configure
      .on('set', this.setSecuritySystemTargetState.bind(this))
    if (this.verboseLog)
      this.log.info("Valid arming states: " + this.validArmingStates(this.excludeModes))

    // configure battery service
    this.accessory.getService(this.hap.Service.Battery) ||
      this.accessory.addService(this.hap.Service.Battery)

    // configure outputs accessory
    if (0 < this.outputs.length) {
      const uuid = this.hap.uuid.generate(this.accessory.displayName + '_outputs_')
      let accessory = this.platform.findRestored(uuid) || this.platform.findConfigured(uuid)
      if (!accessory) {
        // create a new outputs accessory
        accessory = new this.api.platformAccessory('Outputs', uuid, this.hap.Categories.OTHER);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info('Added new accessory: ' + accessory.displayName);
      }
      // wrap with accessory handler
      this.outputsHelper = new NessOutputsHelper(this.platform, accessory, this.verboseLog, this.nessClient, this.outputs)
      this.outputsHelper.configure()
      this.api.updatePlatformAccessories([accessory])
      this.platform.addConfigured(accessory)
    }

    // configure zones accessory
    if (0 < this.zones.length) {
      for (const zone of this.zones) {
        const { id: zoneId, label: zoneLabel } = zone
        if (0 < zoneId && zoneId < NZONES) {
          const uuid = this.hap.uuid.generate(this.accessory.displayName + '_zone_' + zoneId)
          let accessory = this.platform.findRestored(uuid) || this.platform.findConfigured(uuid)
          if (!accessory) {
            // create a new zone accessory
            accessory = new this.api.platformAccessory('Zone ' + zoneLabel, uuid, this.hap.Categories.SENSOR)
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
            this.log.info('Added new: Zone: ' + zoneId + ': ' + accessory.displayName)
          }
          // wrap with accessory handler
          const helper = new NessZoneHelper(this.platform, accessory, this.verboseLog, zone)
          this.zoneHelpers[zoneId - 1] = helper
          helper.configure()
          this.api.updatePlatformAccessories([accessory])
          this.log.info('Configured: Zone: ' + zoneId + ': ' + accessory.displayName)
          this.platform.addConfigured(accessory)
        }
      }
    }

    // setup interface connection

    // configure on connection handler
    this.nessClient.onConnection(() => {
      this.log.info('Interface: Connected: host: ' + this.nessClient.host + ' port: ' + this.nessClient.port)
      this.updateStatusFault(false)

      // get panel status and details - don't issue commands too quickly
      setTimeout(() => this.nessClient.sendCommand(NESS_STATUS_OUTPUTS), 5000)
      setTimeout(() => this.nessClient.sendCommand(NESS_STATUS_AUXOUTPUTS), 5000)
      setTimeout(() => this.nessClient.sendCommand(NESS_STATUS_MISC_ALARMS), 5000)
      setTimeout(() => this.nessClient.sendCommand(NESS_STATUS_VERSION), 5000)
    })

    // configure on error handler
    this.nessClient.onConnectionError((error) => {
      this.log.warn('Interface: ' + error)
      this.updateStatusFault(true)

      // try to re-connect, if retry_limit is reached, wait for poll
      if (this.connect_retry_count < this.connect_retry_limit) {
        this.connect_retry_count = this.connect_retry_count + 1
        setTimeout((retry_count) => {
          if (this.verboseLog)
            this.log.info('Interface: Retry connect: attempt ' + retry_count + '/' + this.connect_retry_limit)
          this.nessClient.connect()
        }, this.connect_retry_wait * 1000, this.connect_retry_count);
      } else {
        if (this.verboseLog)
          this.log.info('Interface: Retry connect: wait for retry in <= ' + this.connect_poll + ' secs')
      }
    })

    // try to connect and then continue to poll
    this.nessClient.connect()

    // nessclient.connect*() schedules nessclient.update() for every 60 secs
    if (this.connect_poll <= NESS_CLIENT_UPDATE_POLL)
      this.log.warn("NESS_CLIENT_UPDATE_POLL: " + NESS_CLIENT_UPDATE_POLL + " secs should be < connect_poll: " + this.connect_poll + " secs")
    setInterval(() => {
      {
        this.connect_retry_count = 0
        const now = new Date()
        const diff = (now.getTime() - this.last_event_received.getTime()) / 1000;
        if (this.verboseLog)
          this.log.info('Interface: Last event received ' + diff + ' secs ago')
        if (this.connect_poll < diff) {
          if (this.verboseLog)
            this.log.info('Interface: Last event received ' + diff + ' secs ago - try to re-connect')
          this.nessClient.disconnect()
          this.nessClient.connect()
        }
      }
    }, this.connect_poll * 1000);
  }

  // handle NessClient eventReceived
  private eventReceived(event: BaseEvent) {
    this.last_event_received = new Date()
    if (this.verboseLog)
      this.log.info("EventReceived: " + JSON.stringify(event))
    if (event instanceof SystemStatusEvent)
      this.handleSystemStatusEvent(event)
    else if (event instanceof StatusUpdate)
      this.handleStatusUpdate(event)
    else this.log.error("Event not known: " + JSON.stringify(event))
  }

  // handle miscellaneous alarms from status request
  private handleMiscAlarmsUpdate(event: MiscellaneousAlarmsUpdate) {
    let lowBattery = false
    let tamper = false
    // kludge because ness client 2.2.0 does not provide access to private member _includedAlarms
    const alarms: AlarmType[] = JSON.parse(JSON.stringify(event))._includedAlarms
    for (const alarm of alarms) {
      switch (alarm) {
        case AlarmType.PANEL_BATTERY_LOW:
        case AlarmType.PANEL_BATTERY_LOW2:
          lowBattery = true
          break
        case AlarmType.EXT_TAMPER:
        case AlarmType.PANEL_TAMPER:
        case AlarmType.KEYPAD_TAMPER:
          tamper = true
          break
      }
    }
    this.updateStatusLowBattery(lowBattery)
    this.updateStatusTampered(tamper)
  }

  // handle panel version
  private handlePanelVersionUpdate(event: PanelVersionUpdate) {
    let model
    switch (event.model) {
      case Model.D16X: model = 'D16x'; break
      case Model.D16X_3G: model = 'D16x - 3G'; break
      default: model = 'D8x'
    }
    this.log.info("Panel details: Model: " + model + " Version: " + event.version)
    this.updateInfo(model, event.version)
  }

  // handle status update event - received in response to a status request
  private handleStatusUpdate(event: StatusUpdate) {
    if (this.verboseLog)
      this.log.info("Status Update: " + event.constructor.name + " :" + JSON.stringify(event))
    if (event instanceof AuxiliaryOutputsUpdate) {
      if (this.outputsHelper) this.outputsHelper.updateAuxilaryOutputs(event)
    }
    else if (event instanceof OutputsUpdate) {
      if (this.outputsHelper) this.outputsHelper.updateOutputs(event)
    }
    else if (event instanceof MiscellaneousAlarmsUpdate)
      this.handleMiscAlarmsUpdate(event)
    else if (event instanceof PanelVersionUpdate)
      this.handlePanelVersionUpdate(event)
    else if (event instanceof ViewStateUpdate)
      this.handleViewStateUpdate(event)
  }

  // handle system status event - received in response to a system event
  private handleSystemStatusEvent(event: SystemStatusEvent) {
    switch (event.type) {
      case EventType.OUTPUT_ON: if (this.outputsHelper) this.outputsHelper.updateOutput(event.zone, true); break
      case EventType.OUTPUT_OFF: if (this.outputsHelper) this.outputsHelper.updateOutput(event.zone, false); break
      case EventType.BATTERY_FAILURE: this.updateStatusLowBattery(true); break
      case EventType.BATTERY_NORMAL: this.updateStatusLowBattery(false); break
    }
  }

  // handle view state update
  private handleViewStateUpdate(event: ViewStateUpdate) {
    // kludge because ness client 2.2.0 does not provide access to private member _state
    const states: State[] = JSON.parse(JSON.stringify(event))._state
    if (this.verboseLog)
      this.log.info("ViewStateUpdate: states: " + JSON.stringify(states))
  }

  // handle panel state change
  private panelStateChanged(state: ArmingState): void {
    this.log.info("Arming state changed: " + state)
    this.panelState = state
    switch (state) {
      case ArmingState.ARMED_AWAY:
        if (this.verboseLog)
          this.log.info('armingStateChanged: ' + state + ' update current hap to: AWAY_ARM and target hap to: AWAY_ARM')
        this.updateSecuritySystemCurrentState(this.hap.Characteristic.SecuritySystemCurrentState.AWAY_ARM)
        this.updateSecuritySystemTargetState(this.hap.Characteristic.SecuritySystemTargetState.AWAY_ARM)
        break
      case ArmingState.ARMED_HOME:
        if (this.verboseLog)
          this.log.info('armingStateChanged: ' + state + ' update current hap to: STAY_ARM and target hap to: STAY_ARM')
        this.updateSecuritySystemCurrentState(this.hap.Characteristic.SecuritySystemCurrentState.STAY_ARM)
        this.updateSecuritySystemTargetState(this.hap.Characteristic.SecuritySystemTargetState.STAY_ARM)
        break
      case ArmingState.DISARMED:
        if (this.verboseLog)
          this.log.info('armingStateChanged: ' + state + ' update current hap to: DISARMED and target hap to: DISARM')
        this.updateSecuritySystemCurrentState(this.hap.Characteristic.SecuritySystemCurrentState.DISARMED)
        this.updateSecuritySystemTargetState(this.hap.Characteristic.SecuritySystemTargetState.DISARM)
        break
      case ArmingState.TRIGGERED:
        if (this.verboseLog)
          this.log.info('armingStateChanged: ' + state + ' update current hap to: ALARM_TRIGGERED and no change to target hap:')
        this.updateSecuritySystemCurrentState(this.hap.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED)
        break
      // we don't really know the target states here, so we have to approximate,
      // eventually one of the definitive events will appear
      case ArmingState.ARMING:
        if (this.verboseLog)
          this.log.info('armingStateChanged: ' + state + ' update target hap to: ARM_AWAY and no change to current hap:')
        this.updateSecuritySystemTargetState(this.hap.Characteristic.SecuritySystemTargetState.AWAY_ARM)
        break
      case ArmingState.ENTRY_DELAY:
        if (this.verboseLog)
          this.log.info('armingStateChanged: ' + state + ' no change to target hap: and no change to current hap:')
        break
      case ArmingState.EXIT_DELAY:
        if (this.verboseLog)
          this.log.info('armingStateChanged: ' + state + ' update target hap to: ARM_AWAY and no change to current hap:')
        this.updateSecuritySystemTargetState(this.hap.Characteristic.SecuritySystemTargetState.AWAY_ARM)
        break
      case ArmingState.UNKNOWN:
      default:
        this.log.error('Arming state change not known: ' + state)

    }
  }

  // handle setSecuritySystemTargetState
  private setSecuritySystemTargetState(targetState: CharacteristicValue, callback: CharacteristicSetCallback) {
    switch (targetState) {
      case this.hap.Characteristic.SecuritySystemTargetState.AWAY_ARM:
        if (this.panelState == ArmingState.ARMED_AWAY) {
          if (this.verboseLog)
            this.log.info('request: AWAY_ARM' + ' current panel state matches - do nothing')
        } else {
          this.nessClient.armAway(this.keypadCode)
          this.log.info('Request: AWAY_ARM' + ' Issue command: ARM AWAY')
        }
        break
      case this.hap.Characteristic.SecuritySystemTargetState.STAY_ARM:
        if (this.panelState == ArmingState.ARMED_HOME) {
          if (this.verboseLog)
            this.log.info('request: STAY_ARM' + ' current panel state matches - do nothing')
        } else {
          this.nessClient.armHome(this.keypadCode)
          this.log.info('Request: STAY_ARM' + ' Issue command: ARM HOME')
        }
        break
      case this.hap.Characteristic.SecuritySystemTargetState.DISARM:
        if (this.panelState == ArmingState.DISARMED) {
          if (this.verboseLog)
            this.log.info('request: DISARM' + ' current panel state matches - do nothing')
        } else {
          this.nessClient.disarm(this.keypadCode)
          this.log.info('Request: DISARM' + ' Issue command: DISARM')
        }
        break
      default:
        this.log.error('Request not known:' + targetState)
        callback(new Error('Request: not known: ' + targetState))
    }
    callback(NO_ERRORS)
  }

  // map hap state to mode
  private hapToMode(state: CharacteristicValue) {
    switch (state) {
      case this.hap.Characteristic.SecuritySystemCurrentState.DISARMED:
        return ArmingMode.OFF
      case this.hap.Characteristic.SecuritySystemCurrentState.NIGHT_ARM:
        return ArmingMode.NIGHT
      case this.hap.Characteristic.SecuritySystemCurrentState.STAY_ARM:
        return ArmingMode.HOME
      case this.hap.Characteristic.SecuritySystemCurrentState.AWAY_ARM:
        return ArmingMode.AWAY
      case this.hap.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED:
        return ArmingMode.TRIGGERED
      default:
        return null
    }
  }

  // update security system current state
  private updateSecuritySystemCurrentState(state: CharacteristicValue) {
    const security = this.accessory.getService(this.hap.Service.SecuritySystem)
    if (security) {
      security.updateCharacteristic(this.hap.Characteristic.SecuritySystemCurrentState, state)
    }
  }

  private updateSecuritySystemTargetState(state: CharacteristicValue) {
    const security = this.accessory.getService(this.hap.Service.SecuritySystem)
    if (security) {
      security.updateCharacteristic(this.hap.Characteristic.SecuritySystemTargetState, state)
    }
  }

  // update info
  private updateInfo(model: string, version: string) {
    const info = this.accessory.getService(this.hap.Service.AccessoryInformation)
    if (info) {
      info.setCharacteristic(this.hap.Characteristic.Model, model)
      info.setCharacteristic(this.hap.Characteristic.FirmwareRevision, version)
    }
  }

  // update status fault
  private updateStatusFault(fault: boolean) {
    const security = this.accessory.getService(this.hap.Service.SecuritySystem)
    if (security) {
      const state = fault ? this.hap.Characteristic.StatusFault.GENERAL_FAULT : this.hap.Characteristic.StatusFault.NO_FAULT
      security.updateCharacteristic(this.hap.Characteristic.StatusFault, state)
    }
  }

  // update low battery status
  private updateStatusLowBattery(lowBattery: boolean) {
    const battery = this.accessory.getService(this.hap.Service.Battery)
    if (battery) {
      const state = lowBattery ? this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
      if (lowBattery)
        this.log.warn("Status Low Battery: Battery Level Low")
      else if (this.verboseLog)
        this.log.info("Battery Status: Normal")
      battery.updateCharacteristic(this.hap.Characteristic.StatusLowBattery, state)
    }
  }

  // update status tampered
  private updateStatusTampered(tampered: boolean) {
    const security = this.accessory.getService(this.hap.Service.SecuritySystem)
    if (security) {
      const state = tampered ? this.hap.Characteristic.StatusTampered.TAMPERED : this.hap.Characteristic.StatusTampered.NOT_TAMPERED
      if (tampered)
        this.log.warn("Status Tampered: " + state)
      security.updateCharacteristic(this.hap.Characteristic.StatusTampered, state)
    }
  }

  // valid arming states
  private validArmingStates(excludeModes: string[]) {
    const states = [
      this.hap.Characteristic.SecuritySystemTargetState.STAY_ARM,
      this.hap.Characteristic.SecuritySystemTargetState.AWAY_ARM,
    ]
    const valid = states.filter((state) =>
      !excludeModes.find((m) => {
        const mode = this.hapToMode(state)
        return mode && m == mode
      }))
    // always include DISARM
    valid.push(this.hap.Characteristic.SecuritySystemTargetState.DISARM)
    return valid
  }

  // handle NessClient zone change
  private zoneChanged(state: [zone: number, change: boolean]) {
    const helper = this.zoneHelpers[state[0] - 1]
    if (helper) helper.zoneChanged(state[1])
  }
}