// Ness D8/16 Panel accessory helper

import {
  API, CharacteristicGetCallback, CharacteristicSetCallback, CharacteristicValue,
  HAP, Logger, PlatformAccessory
} from 'homebridge'
import { ArmingState, NessClient } from 'nessclient'
import {
  AuxiliaryOutputsUpdate, BaseEvent, MiscellaneousAlarmsUpdate,
  OutputsUpdate, PanelVersionUpdate, StatusUpdate, SystemStatusEvent
} from 'nessclient/build/event'
import { AlarmType, EventType, Model } from 'nessclient/build/event-types'
import { ArmingMode, NessD16x, OutputConfig, PLUGIN_NAME, PLATFORM_NAME, ZoneConfig } from './index'
import { NessOutputsHelper } from './outputs'
import { NessZoneHelper } from './zone'

const NO_ERRORS = null
const NESS_STATUS_AUXOUTPUTS = 'S18'
const NESS_STATUS_OUTPUTS = 'S15'
const NESS_STATUS_MISC_ALARMS = 'S13'
const NESS_STATUS_VERSION = 'S17'
const NZONES = 16

export class NessPanelHelper {

  private readonly api: API
  private readonly hap: HAP
  private readonly log: Logger
  private outputsHelper: NessOutputsHelper | null = null
  private panelState: ArmingState = ArmingState.UNKNOWN
  private targetPanelState: ArmingState = ArmingState.UNKNOWN
  private zoneHelpers = new Array<NessZoneHelper>(NZONES)
  private retry_count = 0
  private retry_delay = 2 // retry_delay ** retry_count secs
  private retry_limit = 5 // retry exponential limit

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
    this.nessClient.onStateChange(this.stateChanged.bind(this))
    this.nessClient.onZoneChange(this.zoneChanged.bind(this))

    // configure the information service
    const info = this.accessory.getService(this.hap.Service.AccessoryInformation)
    if (info) info.setCharacteristic(this.hap.Characteristic.Manufacturer, 'Ness')

    // configure the security service
    const security = this.accessory.getService(this.hap.Service.SecuritySystem) ||
      this.accessory.addService(this.hap.Service.SecuritySystem)

    // configure current state handler
    security.getCharacteristic(this.hap.Characteristic.SecuritySystemCurrentState)
      .on('get', this.getSecuritySystemCurrentState.bind(this))

    // configure target state handler
    security.getCharacteristic(this.hap.Characteristic.SecuritySystemTargetState)
      .on('get', this.getSecuritySystemTargetState.bind(this))
      .on('set', this.setSecuritySystemTargetState.bind(this))
      // configure valid arming states/modes
      .setProps({ validValues: this.validArmingStates(this.excludeModes) })
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

    // setup callback for on interface connection
    this.nessClient.onConnection(() => {
      this.log.info('Interface: Connected: host: ' + this.nessClient.host + ' port: ' + this.nessClient.port)
      this.retry_count = 0

      // set StatusFault NO_FAULT
      const security = this.accessory.getService(this.hap.Service.SecuritySystem)
      if (security)
        security.updateCharacteristic(this.hap.Characteristic.StatusFault,
          this.hap.Characteristic.StatusFault.NO_FAULT)

      // get panel status and details - don't issue commands too quickly
      setTimeout(() => this.nessClient.sendCommand(NESS_STATUS_OUTPUTS), 5000)
      setTimeout(() => this.nessClient.sendCommand(NESS_STATUS_AUXOUTPUTS), 5000)
      setTimeout(() => this.nessClient.sendCommand(NESS_STATUS_MISC_ALARMS), 5000)
      setTimeout(() => this.nessClient.sendCommand(NESS_STATUS_VERSION), 5000)
    })

    // setup callback for on interface connection error
    this.nessClient.onConnectionError((error) => {
      this.log.info('Interface: ' + error)

      // set StatusFault GENERAL_FAULT
      const security = this.accessory.getService(this.hap.Service.SecuritySystem)
      if (security) {
        security.updateCharacteristic(this.hap.Characteristic.StatusFault,
          this.hap.Characteristic.StatusFault.GENERAL_FAULT)
      }

      // try to re-connect after delay
      if (this.retry_count < this.retry_limit)
        this.retry_count = this.retry_count + 1
      const delay = this.retry_delay ** this.retry_count
      this.log.info('Interface: Retry to connect in ' + delay + "secs ...")
      setTimeout(() => {
        this.log.info('Interface: Trying to connect: host: ' + this.nessClient.host + ' port: ' + this.nessClient.port)
        this.nessClient.connect()
      }, delay * 1000);
    })

    // try to connect to interface
    if (this.verboseLog)
      this.log.info('Interface: Trying to connect: host: ' + this.nessClient.host + ' port: ' + this.nessClient.port)
    this.nessClient.connect()
  }

  // handle NessClient ArmingState change
  public stateChanged(state: ArmingState): void {
    this.log.info("Arming state changed: " + state)
    this.panelState = state
    let changedHapState = this.panelToHap(state)
    const security = this.accessory.getService(this.hap.Service.SecuritySystem)
    if (security) {
      const targetHapState = security.getCharacteristic(this.hap.Characteristic.SecuritySystemTargetState).value
      // DISARMED is the target panel state for target hap of NIGHT
      if (targetHapState === this.hap.Characteristic.SecuritySystemTargetState.NIGHT_ARM &&
        changedHapState === this.hap.Characteristic.SecuritySystemCurrentState.DISARMED) {
        changedHapState = this.hap.Characteristic.SecuritySystemCurrentState.NIGHT_ARM
      }
      if (0 < changedHapState) {
        if (this.verboseLog)
          this.log.info('stateChanged: ' + state + ' update hap to: ' + this.hapStateText(changedHapState))
        this.updateCurrentHapState(changedHapState)
      } else {
        if (this.verboseLog)
          this.log.info('stateChanged: state not known: ' + state)
      }
    }
  }

  // handle NessClient eventReceived
  private eventReceived(event: BaseEvent) {
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
    // kludge because ness client 2.2.0 does not provide access to private member _includedAlarms
    const alarms: AlarmType[] = JSON.parse(JSON.stringify(event))._includedAlarms
    for (const alarm of alarms) {
      switch (alarm) {
        case AlarmType.PANEL_BATTERY_LOW:
        case AlarmType.PANEL_BATTERY_LOW2:
          this.updateStatusLowBattery(true)
          break
      }
    }
  }

  // handle panel version
  private handlePanelUpdate(event: PanelVersionUpdate) {
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
      this.handlePanelUpdate(event)
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

  // handle getSecuritySystemCurrentState
  private getSecuritySystemCurrentState(callback: CharacteristicGetCallback) {
    const hapState = this.panelToHap(this.panelState)
    if (this.verboseLog)
      this.log.info('Get SecuritySystemCurrentState: ' + hapState);
    hapState < 0 ? callback(new Error("Panel state not known"), hapState) : callback(NO_ERRORS, hapState)
  }

  // handle getSecuritySystemTargetState
  private getSecuritySystemTargetState(callback: CharacteristicGetCallback) {
    const state = this.targetPanelState == ArmingState.UNKNOWN ? this.panelState : this.targetPanelState
    const hapState = this.panelToHap(state)
    if (this.verboseLog)
      this.log.info('Get SecuritySystemTargetState: ' + hapState);
    hapState < 0 ? callback(new Error("Panel state not known"), hapState) : callback(NO_ERRORS, hapState)
  }

  // map hap state to text
  private hapStateText(hapState: number) {
    switch (hapState) {
      case this.hap.Characteristic.SecuritySystemCurrentState.DISARMED:
        return 'DISARMED'
      case this.hap.Characteristic.SecuritySystemCurrentState.AWAY_ARM:
        return 'AWAY'
      case this.hap.Characteristic.SecuritySystemCurrentState.NIGHT_ARM:
        return 'NIGHT'
      case this.hap.Characteristic.SecuritySystemCurrentState.STAY_ARM:
        return 'HOME'
      case this.hap.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED:
        return 'TRIGGERED'
      default:
        return 'NOT KNOWN'
    }
  }

  // map panel state to hap state
  private panelToHap(panelState: ArmingState) {
    let hapState = -1
    switch (panelState) {
      case ArmingState.ARMED_HOME:
        hapState = this.hap.Characteristic.SecuritySystemCurrentState.STAY_ARM
        break
      case ArmingState.ARMED_AWAY:
        hapState = this.hap.Characteristic.SecuritySystemCurrentState.AWAY_ARM
        break
      case ArmingState.ARMED_NIGHT:
        hapState = this.hap.Characteristic.SecuritySystemCurrentState.NIGHT_ARM
        break
      case ArmingState.DISARMED:
        hapState = this.hap.Characteristic.SecuritySystemCurrentState.DISARMED
        break
      case ArmingState.TRIGGERED:
        hapState = this.hap.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED
        break
      case ArmingState.UNKNOWN:
      case ArmingState.ARMING:
      case ArmingState.ENTRY_DELAY:
      case ArmingState.EXIT_DELAY:
        break
      default:
        this.log.error('Panel state change not known: panel state: ' + panelState)
    }
    return hapState
  }

  // handle setSecuritySystemTargetState
  private setSecuritySystemTargetState(targetHapState: CharacteristicValue, callback: CharacteristicSetCallback) {
    const panelAsHap = this.panelToHap(this.panelState)
    if (this.verboseLog)
      this.log.info('Request: ' + this.hapStateText(targetHapState as number) + ' (Panel state: ' + this.hapStateText(panelAsHap) + ')')
    if (panelAsHap === targetHapState) {
      this.updateCurrentHapState(targetHapState)
      if (this.verboseLog)
        this.log.info('Request: ' + this.hapStateText(targetHapState) + ' (Panel state matches - nothing to do)')
    } else {
      switch (targetHapState) {
        case this.hap.Characteristic.SecuritySystemTargetState.STAY_ARM:
          this.targetPanelState = ArmingState.ARMED_HOME
          this.nessClient.armHome(this.keypadCode)
          this.log.info('Request: ' + this.hapStateText(targetHapState) + ' Command: ARM HOME')
          break
        case this.hap.Characteristic.SecuritySystemTargetState.AWAY_ARM:
          this.targetPanelState = ArmingState.ARMED_AWAY
          this.nessClient.armAway(this.keypadCode)
          this.log.info('Request: ' + this.hapStateText(targetHapState) + ' Command: ARM AWAY')
          break
        case this.hap.Characteristic.SecuritySystemTargetState.NIGHT_ARM:
          // NIGHT_ARM does not exist on Ness, so just make it another state of DISARMED
          if (this.panelState === ArmingState.DISARMED) {
            this.updateCurrentHapState(this.hap.Characteristic.SecuritySystemCurrentState.NIGHT_ARM)
          } else {
            this.targetPanelState = ArmingState.DISARMED
            this.nessClient.disarm(this.keypadCode)
            this.log.info('Request: ' + this.hapStateText(targetHapState) + ' Command: DISARM')
          }
          break
        case this.hap.Characteristic.SecuritySystemTargetState.DISARM:
          this.targetPanelState = ArmingState.DISARMED
          this.nessClient.disarm(this.keypadCode)
          this.log.info('Request: ' + this.hapStateText(targetHapState) + ' Command: DISARM')
          break
        default:
          callback(new Error('Request: not known: ' + targetHapState))
      }
    }
    callback(NO_ERRORS)
  }

  // map target state to mode
  private stateToMode(state: CharacteristicValue) {
    switch (state) {
      case this.hap.Characteristic.SecuritySystemCurrentState.DISARMED:
        return ArmingMode.OFF
      case this.hap.Characteristic.SecuritySystemCurrentState.NIGHT_ARM:
        return ArmingMode.NIGHT
      case this.hap.Characteristic.SecuritySystemCurrentState.STAY_ARM:
        return ArmingMode.HOME
      case this.hap.Characteristic.SecuritySystemCurrentState.AWAY_ARM:
        return ArmingMode.AWAY
      default:
        return null
    }
  }

  // update current hap state
  private updateCurrentHapState(state: number) {
    const security = this.accessory.getService(this.hap.Service.SecuritySystem)
    if (security) {
      security.updateCharacteristic(this.hap.Characteristic.SecuritySystemCurrentState, state)
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

  // update low battery status
  private updateStatusLowBattery(state: boolean) {
    const battery = this.accessory.getService(this.hap.Service.Battery)
    if (battery) {
      if (state) {
        this.log.warn("Battery Status: Low Battery")
        battery.updateCharacteristic(this.hap.Characteristic.StatusLowBattery,
          this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW)
      }
      else {
        this.log.info("Battery Status: Normal")
        battery.updateCharacteristic(this.hap.Characteristic.StatusLowBattery,
          this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL)
      }
    }
  }

  // valid arming states
  private validArmingStates(excludeModes: string[]) {
    const states = [
      this.hap.Characteristic.SecuritySystemTargetState.NIGHT_ARM,
      this.hap.Characteristic.SecuritySystemTargetState.STAY_ARM,
      this.hap.Characteristic.SecuritySystemTargetState.AWAY_ARM
    ]
    const valid = states.filter((state) =>
      !excludeModes.find((m) => {
        const mode = this.stateToMode(state)
        return mode && m === mode
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
