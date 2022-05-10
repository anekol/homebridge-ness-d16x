// Ness D8x/D16x alarm panel platform using NessClient

// Change Log
// 0.0.8
// * reworked interface connection logic with heartbeat and error support
// 0.0.7
// * add retry logic on interface connection errors
// 0.0.6
// * add ability to control AUX outputs
// 0.0.5
// * add verbose logging
// 0.0.4: 
// * Add support for Outputs and AuxiliaryOutputs, add low battery alarm
// * Ensure illegal characteristic values are not set on unknown arming state

/* eslint-disable no-unused-vars */
import { API, APIEvent, DynamicPlatformPlugin, HAP, Logger, PlatformAccessory, PlatformConfig } from 'homebridge'
import { NessClient } from 'nessclient'
import { NessPanelHelper } from './panel'

export const PLATFORM_NAME = 'NessD16x'
export const PLUGIN_NAME = 'homebridge-ness-d16x' // Plugin name from package.json
export enum ArmingMode {
  AWAY = 'AWAY',
  HOME = 'HOME',
  NIGHT = 'NIGHT',
  OFF = 'OFF',
  TRIGGERED = 'TRIGGERED'
}
export enum SensorType {
  CONTACT = 'CONTACT',
  MOTION = 'MOTION',
  SMOKE = 'SMOKE'
}
export type OutputConfig = { id: number, label: string }
export type ZoneConfig = { id: number, label: string, type: SensorType }

module.exports = (api: API) => {
  api.registerPlatform(PLATFORM_NAME, NessD16x)
}

export class NessD16x implements DynamicPlatformPlugin {
  private readonly configured: PlatformAccessory[] = []
  private readonly hap: HAP
  private readonly host: string
  private readonly keypadCode: string
  private readonly name: string
  private readonly nessClient: NessClient
  private readonly outputs: OutputConfig[]
  private readonly port: string = '2401'
  private readonly verboseLog: boolean = false
  private readonly restored: PlatformAccessory[] = []
  private readonly excludeModes: ArmingMode[]
  private readonly zones: ZoneConfig[]

  // constructor
  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API
  ) {
    this.hap = api.hap

    //  user config
    this.name = config.name as string || PLATFORM_NAME
    this.host = config.host as string || 'localhost'
    this.port = config.port as string || '2401'
    this.keypadCode = config.keypadCode as string || ''
    this.verboseLog = config.verboseLog as boolean || false
    this.nessClient = new NessClient(this.host, +this.port)

    // map config strings to enums
    this.outputs = ((config.outputs || []) as { id: string, label: string }[])
      .map((a) => { return { id: parseInt(a.id), label: a.label } })
    this.excludeModes = ((config.excludeModes || []) as string[])
      .map((m) => m.toUpperCase() as ArmingMode)
    this.zones = ((config.zones || []) as { id: string, type: string, label: string }[])
      .map((z) => { return { id: parseInt(z.id), label: z.label, type: z.type.toUpperCase() as SensorType } })

    // wait for any accessories to be restored
    api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      this.log.info('Finished restoring cached accessories')

      // configure the main panel and it's accessories
      const uuid = this.hap.uuid.generate(this.name + '_panel')
      let accessory = this.findRestored(uuid)
      if (!accessory) {
        accessory = new this.api.platformAccessory(this.name, uuid, this.hap.Categories.SECURITY_SYSTEM)
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
        this.log.info('Added new: ' + accessory.displayName)
      }
      new NessPanelHelper(this, accessory, this.verboseLog, this.nessClient, this.keypadCode, this.excludeModes, this.outputs, this.zones).configure()
      this.log.info('Configured: ' + accessory.displayName)
      this.api.updatePlatformAccessories([accessory])
      this.addConfigured(accessory)

      // deregister any restored accessories not configured
      for (const r of this.restored) {
        if (!this.findConfigured(r.UUID)) {
          this.log.info('Deregister: not configured: ' + r.displayName)
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [r])
        }
      }
    })
  }

  // add accessory to configured list
  public addConfigured(accessory: PlatformAccessory): void {
    this.configured.push(accessory)
  }

  // configureAccessory will be called once for every cached accessory restored
  public configureAccessory(accessory: PlatformAccessory): void {
    this.restored.push(accessory)
  }

  // find configured accessory
  public findConfigured(uuid: string): PlatformAccessory | undefined {
    return this.configured.find(a => a.UUID === uuid)
  }

  // find restored accessory
  public findRestored(uuid: string): PlatformAccessory | undefined {
    return this.restored.find(a => a.UUID === uuid)
  }
}
