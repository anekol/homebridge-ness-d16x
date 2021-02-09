// Ness D8/16 Panel accessory helper

import { API, CharacteristicSetCallback, CharacteristicValue, HAP, Logger, PlatformAccessory, Service } from 'homebridge'
import { ArmingState, NessClient } from 'nessclient'
import { ArmingMode, NessD16x, PLUGIN_NAME, PLATFORM_NAME, ZoneConfig } from './index'
import { NessZoneHelper } from './zone'

const NO_ERRORS = null
const NESS_VERSION = 'S17'
const NZONES = 16

export class NessPanelHelper {
  private readonly Accessory: typeof PlatformAccessory;
  private readonly api: API
  private readonly hap: HAP
  private readonly log: Logger
  private panelState: ArmingState = ArmingState.UNKNOWN
  private service: Service | null = null
  private zoneHelpers = new Array<NessZoneHelper>(NZONES)

  // constructor
  constructor (
    private readonly platform: NessD16x,
    private readonly accessory: PlatformAccessory,
    private readonly nessClient: NessClient,
    private readonly keypadCode: string,
    private readonly excludeModes: string[],
    private readonly zones: ZoneConfig[]
  ) {
    this.Accessory = platform.api.platformAccessory
    this.api = platform.api
    this.hap = platform.api.hap
    this.log = platform.log
  }

  // configure the accessory
  public configure () {
    // configure NessClient event listeners
    this.nessClient.onEventReceived(this.eventReceived.bind(this))
    this.nessClient.onStateChange(this.stateChanged.bind(this))
    this.nessClient.onZoneChange(this.zoneChanged.bind(this))

    // configure the information service
    this.accessory.getService(this.hap.Service.AccessoryInformation)!
      .setCharacteristic(this.hap.Characteristic.Manufacturer, 'Ness')

    // update panel model and software version
    this.nessClient.sendCommand(NESS_VERSION)

    // configure the security service
    this.service = this.accessory.getService(this.hap.Service.SecuritySystem) ||
      this.accessory.addService(this.hap.Service.SecuritySystem)
    this.service.getCharacteristic(this.hap.Characteristic.SecuritySystemTargetState)

      // configure valid arming states/modes
      .setProps({ validValues: this.validArmingStates(this.excludeModes) })

      // provide event handler for setSecuritySystemTargetState
      // all other state is updated asynchronously
      .on('set', this.setSecuritySystemTargetState.bind(this))

    // configure the zones
    for (const zone of this.zones) {
      const { id: zoneId, label: zoneLabel } = zone
      if (zoneId > 0 && zoneId < NZONES) {
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
  }

  // handle setSecuritySystemTargetState
  private setSecuritySystemTargetState (targetHapState: CharacteristicValue, callback: CharacteristicSetCallback) {
    const panelAsHap = this.panelToHap(this.panelState)
    this.log.debug('Request: ' + this.hapStateText(targetHapState as number) + ' (Panel state: ' + this.hapStateText(panelAsHap) + ')')
    if (panelAsHap === targetHapState) {
      this.updateCurrentHapState(targetHapState as number)
      this.log.debug('Request: ' + this.hapStateText(targetHapState as number) + ' (Panel state matches - No command)')
    } else {
      switch (targetHapState) {
        case this.hap.Characteristic.SecuritySystemTargetState.STAY_ARM:
          this.nessClient.armHome(this.keypadCode)
          this.log.info('Request: ' + this.hapStateText(targetHapState) + ' Command: ARM HOME')

          break
        case this.hap.Characteristic.SecuritySystemTargetState.AWAY_ARM:
          this.nessClient.armAway(this.keypadCode)
          this.log.info('Request: ' + this.hapStateText(targetHapState) + ' Command: ARM AWAY')
          break
        case this.hap.Characteristic.SecuritySystemTargetState.NIGHT_ARM:
          // NIGHT_ARM does not exist on Ness, so just make it another state of DISARMED
          if (this.panelState === ArmingState.DISARMED) {
            this.updateCurrentHapState(this.hap.Characteristic.SecuritySystemCurrentState.NIGHT_ARM)
          } else {
            this.nessClient.disarm(this.keypadCode)
            this.log.info('Request: ' + this.hapStateText(targetHapState) + ' Command: DISARM')
          }
          break
        case this.hap.Characteristic.SecuritySystemTargetState.DISARM:
          this.nessClient.disarm(this.keypadCode)
          this.log.info('Request: ' + this.hapStateText(targetHapState) + ' Command: DISARM')
          break
        default:
          callback(new Error('Request: not known: ' + targetHapState))
      }
    }
    callback(NO_ERRORS)
  }

  // handle NessClient eventReceived
  private eventReceived (event: {}) {
    switch (event.constructor.name) {
      case 'PanelVersionUpdate':
        ((event) => {
          const { _model, _majorVersion, _minorVersion } = event as { _model: number, _majorVersion: number, _minorVersion: number }
          const version = _majorVersion.toString + '.' + _minorVersion.toString
          let model
          switch (_model) {
            case 0:
              model = 'D16x'
              break
            case 0x4:
              model = 'D16x - 3G'
              break
            default:
              model = 'D8x'
          }
          this.updateInfo(model, version)
        })(event)
    }
  }

  // handle NessClient ArmingState change
  public stateChanged (state: ArmingState) {
    this.panelState = state
    let hapState: number = this.panelToHap(state)
    const targetHapState = this.service!.getCharacteristic(this.hap.Characteristic.SecuritySystemTargetState).value

    if (hapState === this.hap.Characteristic.SecuritySystemCurrentState.DISARMED &&
      targetHapState === this.hap.Characteristic.SecuritySystemTargetState.NIGHT_ARM) {
      // DISARMED is the target panel state for target hap of NIGHT
      hapState = this.hap.Characteristic.SecuritySystemCurrentState.NIGHT_ARM
    }
    if (hapState > 0) {
      this.log.debug('Panel state changed: ' + state + ' update hap to: ' + this.hapStateText(hapState))
      this.updateCurrentHapState(hapState)
    } else {
      this.log.debug('Panel state changed: ' + state + ' no hap update')
    }
  }

  // handle NessClient zone change
  private zoneChanged (state: [zone: number, change: boolean]) {
    const helper = this.zoneHelpers[state[0] - 1]
    if (helper) helper.zoneChanged(state[1])
  }

  // map hap state to text
  private hapStateText (hapState: number) {
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
  private panelToHap (panelState: ArmingState) {
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

  // map target state to mode
  private stateToMode (state: CharacteristicValue) {
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
  };

  // update current hap state
  private updateCurrentHapState (state: number) {
    this.service!.updateCharacteristic(this.hap.Characteristic.SecuritySystemCurrentState, state)
  }

  // update info
  private updateInfo (model: string, version: string) {
    if (this.accessory) {
      const service = this.accessory.getService(this.hap.Service.AccessoryInformation)
      if (service) {
        service.setCharacteristic(this.hap.Characteristic.Model, model)
        service.setCharacteristic(this.hap.Characteristic.FirmwareRevision, version)
      }
    }
  }

  // valid arming states
  private validArmingStates (excludeModes: string[]) {
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
}
