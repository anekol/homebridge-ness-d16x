// Ness D8/16 Panel accessory helper

import { API, CharacteristicGetCallback, CharacteristicSetCallback, CharacteristicValue, HAP, Logger, PlatformAccessory, Service } from 'homebridge'
import { ArmingState, NessClient } from 'nessclient'
import { BaseEvent, AuxiliaryOutputsUpdate, OutputsUpdate, PanelVersionUpdate, SystemStatusEvent } from 'nessclient/build/event'
import { AuxiliaryOutputType, EventType, OutputType, Model } from 'nessclient/build/event-types'
import { TextEncoder } from 'util'
import { ArmingMode, NessD16x, OutputConfig, PLUGIN_NAME, PLATFORM_NAME, ZoneConfig } from './index'
import { NessOutputsHelper } from './outputs'
import { NessZoneHelper } from './zone'

const NO_ERRORS = null
const NESS_STATUS_AUXOUTPUTS = 'S18'
const NESS_STATUS_OUTPUTS = 'S15'
const NESS_STATUS_VERSION = 'S17'
const NZONES = 16

export class NessPanelHelper {
  private readonly Accessory: typeof PlatformAccessory;
  private readonly api: API
  private readonly hap: HAP
  private readonly log: Logger
  private outputsHelper: NessOutputsHelper | null = null
  private panelState: ArmingState = ArmingState.UNKNOWN
  private service: Service | null = null
  private targetPanelState: ArmingState = ArmingState.UNKNOWN
  private zoneHelpers = new Array<NessZoneHelper>(NZONES)

  // constructor
  constructor(
    private readonly platform: NessD16x,
    private readonly accessory: PlatformAccessory,
    private readonly nessClient: NessClient,
    private readonly keypadCode: string,
    private readonly excludeModes: string[],
    private readonly outputs: OutputConfig[],
    private readonly zones: ZoneConfig[]
  ) {
    this.Accessory = platform.api.platformAccessory
    this.api = platform.api
    this.hap = platform.api.hap
    this.log = platform.log
  }

  // configure the accessory
  public configure(): void {

    // configure NessClient event listeners
    this.nessClient.onEventReceived(this.eventReceived.bind(this))
    this.nessClient.onStateChange(this.stateChanged.bind(this))
    this.nessClient.onZoneChange(this.zoneChanged.bind(this))

    // configure the information service
    const info = this.accessory.getService(this.hap.Service.AccessoryInformation)
    if (info) info.setCharacteristic(this.hap.Characteristic.Manufacturer, 'Ness')

    // configure the security service
    this.service = this.accessory.getService(this.hap.Service.SecuritySystem) ||
      this.accessory.addService(this.hap.Service.SecuritySystem)
    this.service.getCharacteristic(this.hap.Characteristic.SecuritySystemCurrentState)
      .on('get', this.getSecuritySystemCurrentState.bind(this))
    this.service.getCharacteristic(this.hap.Characteristic.SecuritySystemTargetState)
      .on('get', this.getSecuritySystemTargetState.bind(this))
      .on('set', this.setSecuritySystemTargetState.bind(this))
      // configure valid arming states/modes
      .setProps({ validValues: this.validArmingStates(this.excludeModes) })
    this.log.debug("Valid arming states: " + this.validArmingStates(this.excludeModes))

    // configure outputs
    const uuid = this.hap.uuid.generate(this.accessory.displayName + '_outputs_')
    let accessory = this.platform.findRestored(uuid) || this.platform.findConfigured(uuid)
    if (!accessory) {
      // create a new outputs accessory
      accessory = new this.Accessory('Outputs', uuid, this.hap.Categories.OTHER);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info('Added new accessory: ' + accessory.displayName);
    }
    // wrap with accessory handler
    this.outputsHelper = new NessOutputsHelper(this.platform, accessory, this.outputs)
    this.outputsHelper.configure()
    this.api.updatePlatformAccessories([accessory])
    this.platform.addConfigured(accessory)

    // configure zones
    for (const zone of this.zones) {
      const { id: zoneId, label: zoneLabel } = zone
      if (0 < zoneId && zoneId < NZONES) {
        const uuid = this.hap.uuid.generate(this.accessory.displayName + '_zone_' + zoneId)
        let accessory = this.platform.findRestored(uuid) || this.platform.findConfigured(uuid)
        if (!accessory) {
          // create a new zone accessory
          accessory = new this.Accessory('Zone ' + zoneLabel, uuid, this.hap.Categories.SENSOR)
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
          this.log.info('Added new: Zone: ' + zoneId + ': ' + accessory.displayName)
        }
        // wrap with accessory handler
        const helper = new NessZoneHelper(this.platform, accessory, zone)
        this.zoneHelpers[zoneId - 1] = helper
        helper.configure()
        this.api.updatePlatformAccessories([accessory])
        this.log.info('Configured: Zone: ' + zoneId + ': ' + accessory.displayName)
        this.platform.addConfigured(accessory)
      }
    }

    // try to connect to interface
    this.nessClient.connect()

    // on interface connection
    this.nessClient.onConnection(() => {
      this.log.info('Interface: Connected: host: ' + this.nessClient.host + ' port: ' + this.nessClient.port)

      // get panel status and details - don't issue commands too quickly
      setTimeout(() => this.nessClient.sendCommand(NESS_STATUS_OUTPUTS), 5000)
      setTimeout(() => this.nessClient.sendCommand(NESS_STATUS_AUXOUTPUTS), 5000)
      setTimeout(() => this.nessClient.sendCommand(NESS_STATUS_VERSION), 5000)
    })

    // on interface connection error
    this.nessClient.onConnectionError((error) => {
      this.log.error('Interface: ' + error)
      this.platform.removeAllConfigured()
    })

  }

  // handle NessClient ArmingState change
  public stateChanged(state: ArmingState): void {
    this.log.info("Arming state changed: " + state)
    this.panelState = state
    let changedHapState = this.panelToHap(state)
    if (this.service) {
      const targetHapState = this.service.getCharacteristic(this.hap.Characteristic.SecuritySystemTargetState).value
      // DISARMED is the target panel state for target hap of NIGHT
      if (targetHapState === this.hap.Characteristic.SecuritySystemTargetState.NIGHT_ARM &&
        changedHapState === this.hap.Characteristic.SecuritySystemCurrentState.DISARMED) {
        changedHapState = this.hap.Characteristic.SecuritySystemCurrentState.NIGHT_ARM
      }
      if (0 < changedHapState) {
        this.log.debug('stateChanged: ' + state + ' update hap to: ' + this.hapStateText(changedHapState))
        this.updateCurrentHapState(changedHapState)
      } else {
        this.log.debug('stateChanged: state not known: ' + state)
      }
    }
  }

  // handle NessClient eventReceived
  private eventReceived(event: BaseEvent) {
    this.log.debug("eventReceived: " + event.constructor.name + " :" + JSON.stringify(event))
    switch (event.constructor.name) {
      case 'OutputsUpdate':
        ((event) => {
          const outputs = this.outputsFromEvent(event)
          this.log.info("OutputsUpdate: " + outputs)
          for (var o of outputs) {
            switch (o) {
              case OutputType.AUX1:
                this.updateOutput(1, true)
                break
              case OutputType.AUX2:
                this.updateOutput(2, true)
                break
              case OutputType.AUX3:
                this.updateOutput(3, true)
                break
              case OutputType.AUX4:
                this.updateOutput(4, true)
                break
            }
          }
        })(event as OutputsUpdate)
        break
      case 'AuxiliaryOutputsUpdate':
        ((event) => {
          const outputs = this.auxOutputsFromEvent(event)
          this.log.info("AuxiliaryOutputsUpdate: " + outputs)
          for (var o of outputs) {
            switch (o) {
              case AuxiliaryOutputType.AUX_1:
                this.updateOutput(1, true)
                break
              case AuxiliaryOutputType.AUX_2:
                this.updateOutput(2, true)
                break
              case AuxiliaryOutputType.AUX_3:
                this.updateOutput(3, true)
                break
              case AuxiliaryOutputType.AUX_4:
                this.updateOutput(4, true)
                break
              case AuxiliaryOutputType.AUX_5:
                this.updateOutput(5, true)
                break
              case AuxiliaryOutputType.AUX_6:
                this.updateOutput(6, true)
                break
              case AuxiliaryOutputType.AUX_7:
                this.updateOutput(7, true)
                break
              case AuxiliaryOutputType.AUX_8:
                this.updateOutput(8, true)
                break
            }
          }
        })(event as AuxiliaryOutputsUpdate)
        break
      case 'SystemStatusEvent':
        let id
        ((event) => {
          switch (event.type) {
            case EventType.OUTPUT_ON:
              id = event.zone
              this.log.info("OutputOn: " + id)
              this.updateOutput(id, true)
              break
            case EventType.OUTPUT_OFF:
              id = event.zone
              this.log.info("OutputOff: " + id)
              this.updateOutput(id, false)
              break
            default:
              this.log.info("SystemStatusEvent: type: " + event.type)
              break
          }
        })(event as SystemStatusEvent)
        break
      case 'PanelVersionUpdate':
        ((event) => {
          let model
          switch (event.model) {
            case Model.D16X:
              model = 'D16x'
              break
            case Model.D16X_3G:
              model = 'D16x - 3G'
              break
            default:
              model = 'D8x'
          }
          this.updateInfo(model, event.version)
          this.log.info("Panel details: Model: " + model + " Version: " + event.version)
        })(event as PanelVersionUpdate)
        break
    }
  }

  // handle getSecuritySystemCurrentState
  private getSecuritySystemCurrentState(callback: CharacteristicGetCallback) {
    const hapState = this.panelToHap(this.panelState)
    this.log.debug('Get SecuritySystemCurrentState: ' + hapState);
    hapState < 0 ? callback(new Error("Panel state not known"), hapState) : callback(NO_ERRORS, hapState)
  }

  // handle getSecuritySystemTargetState
  private getSecuritySystemTargetState(callback: CharacteristicGetCallback) {
    const state = this.targetPanelState == ArmingState.UNKNOWN ? this.panelState : this.targetPanelState
    const hapState = this.panelToHap(state)
    this.log.debug('Get SecuritySystemTargetState: ' + hapState);
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

  // extract outputs from AuxiliaryOutputsUpdate event
  // kludge because ness client 2.2.0 does not provide access to private member _outputs
  private auxOutputsFromEvent(event: AuxiliaryOutputsUpdate): AuxiliaryOutputType[] {
    const text = JSON.stringify(event)
    return JSON.parse(text)._outputs
  }

  // extract outputs from OutputsUpdate event
  // kludge because ness client 2.2.0 does not provide access to private member _outputs
  private outputsFromEvent(event: OutputsUpdate): OutputType[] {
    const text = JSON.stringify(event)
    return JSON.parse(text)._outputs
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
    this.log.debug('Request: ' + this.hapStateText(targetHapState as number) + ' (Panel state: ' + this.hapStateText(panelAsHap) + ')')
    if (panelAsHap === targetHapState) {
      this.updateCurrentHapState(targetHapState)
      this.log.debug('Request: ' + this.hapStateText(targetHapState) + ' (Panel state matches - nothing to do)')
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
    if (this.service)
      this.service.updateCharacteristic(this.hap.Characteristic.SecuritySystemCurrentState, state)
  }

  // update info
  private updateInfo(model: string, version: string) {
    if (this.accessory) {
      const service = this.accessory.getService(this.hap.Service.AccessoryInformation)
      if (service) {
        service.setCharacteristic(this.hap.Characteristic.Model, model)
        service.setCharacteristic(this.hap.Characteristic.FirmwareRevision, version)
      }
    }
  }
  // update output
  private updateOutput(id: number, state: boolean) {
    if (this.outputsHelper) this.outputsHelper.updateOutput(id, state)
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
    this.log.debug("zoneChanged: zone: " + state[0], " change: " + state[1])
    const helper = this.zoneHelpers[state[0] - 1]
    if (helper) helper.zoneChanged(state[1])
  }
}
