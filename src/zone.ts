// Zone accessory helper

import { EventTransmissionCounters } from 'hap-nodejs/dist/lib/gen/HomeKit'
import { CharacteristicGetCallback, HAP, Logger, PlatformAccessory, Service } from 'homebridge'
import { NessD16x, SensorType, ZoneConfig } from './index'

const NO_ERRORS = null

export class NessZoneHelper {
  private readonly configured: Service[] = []
  private readonly hap: HAP
  private readonly log: Logger
  private readonly restored: Service[] = []
  private service: Service | null = null
  private zoneChange = false

  // constructor
  constructor(
    private readonly platform: NessD16x,
    private readonly accessory: PlatformAccessory,
    private readonly zone: ZoneConfig
  ) {
    this.hap = this.platform.api.hap
    this.log = this.platform.log
  }

  // configure
  public configure(): void {
    // register restored services
    for (var s of this.accessory.services) {
      this.log.debug('Restored service: ' + s.displayName + s.UUID)
      this.addRestored(s)
    }

    // configure the information service
    const info = this.accessory.getService(this.hap.Service.AccessoryInformation)
    if (info) {
      info
        .setCharacteristic(this.hap.Characteristic.Manufacturer, 'Ness')
        .setCharacteristic(this.hap.Characteristic.Model, 'Zone')
      this.addConfigured(info)
    }


    // configure the sensor service
    switch (this.zone.type) {
      case SensorType.CONTACT:
        this.service = this.findRestored(this.hap.Service.ContactSensor.UUID) ||
          this.accessory.addService(this.hap.Service.ContactSensor)
        this.service.getCharacteristic(this.hap.Characteristic.ContactSensorState)
          .on('get', this.getContactSensorState.bind(this))
        break
      case SensorType.MOTION:
        this.service = this.findRestored(this.hap.Service.MotionSensor.UUID) ||
          this.accessory.addService(this.hap.Service.MotionSensor)
        this.service.getCharacteristic(this.hap.Characteristic.MotionDetected)
          .on('get', this.getMotionDetected.bind(this))
        break
      case SensorType.SMOKE:
        this.service = this.findRestored(this.hap.Service.SmokeSensor.UUID) ||
          this.accessory.addService(this.hap.Service.SmokeSensor)
        this.service.getCharacteristic(this.hap.Characteristic.SmokeDetected)
          .on('get', this.getSmokeDetected.bind(this))
        break
      default:
        this.log.error('Zone sensor type not known: zone: ' + this.zone.id + ' type: ' + this.zone.type)
        break
    }
    if (this.service) {
      this.service.displayName = this.zone.label
      this.service.setCharacteristic(this.hap.Characteristic.StatusActive, true)
      this.addConfigured(this.service)
    }

    // remove any restored services not configured
    for (const r of this.restored) {
      if (r.UUID && !this.findConfigured(r.UUID)) {
        this.accessory.removeService(r)
        this.log.info('Remove Service: not configured: ' + r.displayName)
      }
    }
    this.platform.api.updatePlatformAccessories([this.accessory])
  }

  // zone changed
  public zoneChanged(change: boolean): void {
    this.zoneChange = change
    if (this.service) {
      this.log.debug('Zone changed: zone: ' + this.zone.id + ' state: ' + change)
      switch (this.zone.type) {
        case SensorType.CONTACT:
          this.service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.zoneChange)
          break
        case SensorType.MOTION:
          this.service.updateCharacteristic(this.hap.Characteristic.MotionDetected, this.zoneChange)
          break
        case SensorType.SMOKE:
          this.service.updateCharacteristic(this.hap.Characteristic.SmokeDetected, this.zoneChange)
          break
      }
    }
  }

  // handle getContact State
  private getContactSensorState(callback: CharacteristicGetCallback) {
    const state = this.zoneChange
      ? this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED
    this.log.debug('Get ContactState: ' + state)
    callback(NO_ERRORS, state)
  }

  // handle getMotionDetected
  private getMotionDetected(callback: CharacteristicGetCallback) {
    const state = this.zoneChange
    this.log.debug('Get MotionedDetected: ' + state)
    callback(NO_ERRORS, state)
  }

  // handle getSmokeDetected
  private getSmokeDetected(callback: CharacteristicGetCallback) {
    const state = this.zoneChange
      ? this.hap.Characteristic.SmokeDetected.SMOKE_DETECTED
      : this.hap.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED
    this.log.debug('Get SmokeDetected: ' + state)
    callback(NO_ERRORS, state)
  }
  // add service to configured list
  private addConfigured(service: Service): void {
    this.configured.push(service)
  }

  // add service to restored list
  private addRestored(service: Service): void {
    this.restored.push(service)
  }

  // find configured service
  private findConfigured(uuid: string): Service | undefined {
    return this.configured.find(s => s.UUID === uuid)
  }

  // find restored service
  private findRestored(uuid: string): Service | undefined {
    return this.restored.find(s => s.UUID === uuid)
  }
}
