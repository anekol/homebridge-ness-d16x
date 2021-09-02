// Ness D8/16 Aux accessory helper

import { CharacteristicGetCallback, CharacteristicSetCallback, CharacteristicValue, HAP, Logger, PlatformAccessory, Service } from "homebridge";
import { NessD16x, OutputConfig } from './index'

const NO_ERRORS = null
const NOUTPUTS = 8

export class NessOutputsHelper {
	private readonly configured: Service[] = []
	private readonly hap: HAP
	private readonly log: Logger
	private readonly restored: Service[] = []
	private status: boolean[] = []

	// constructor
	constructor(
		private readonly platform: NessD16x,
		private readonly accessory: PlatformAccessory,
		private readonly outputs: OutputConfig[],
	) {
		this.hap = platform.api.hap
		this.log = platform.log

		// init status
		for (var i = 1; i <= NOUTPUTS; ++i) {
			this.status[i] = false
		}
	}

	// configure the accessory
	public configure(): void {
		// register restored services
		for (var s of this.accessory.services) {
			this.log.debug('Restored service: ' + s.displayName + ' subtype: ' + s.subtype + ': ' + s.UUID)
			this.addRestored(s)
		}

		// configure the information service
		const info = this.accessory.getService(this.hap.Service.AccessoryInformation)!
		if (info) info.setCharacteristic(this.hap.Characteristic.Manufacturer, 'Ness')
		this.addConfigured(info)

		// configure output services
		for (var output of this.outputs) {
			if (1 <= output.id && output.id <= NOUTPUTS) {

				let service = this.findRestored(this.hap.Service.Outlet.UUID, output.id)
					|| this.accessory.addService(this.hap.Service.Outlet, output.label, output.id.toString());
				service.displayName = output.label
				service.getCharacteristic(this.hap.Characteristic.On)
					.on('get', this.getOn.bind(this, output.id.toString()))
					.on('set', this.setOn.bind(this, output.id, service))
				this.addConfigured(service)
				this.log.info("Configured: Output: " + output.id + ": " + output.label)

			}
		}
		// remove any restored services not configured
		for (const r of this.restored) {
			if (r.subtype && !this.findConfigured(parseInt(r.subtype))) {
				this.accessory.removeService(r)
				this.log.info('Remove Output: not configured: ' + r.displayName)
			}
		}
		this.platform.api.updatePlatformAccessories([this.accessory])
	}

	// update output state
	public updateOutput(id: number, state: boolean): void {
		this.log.debug("Update Output: id: " + id + " state: " + state + " UUID: " + this.hap.Service.Outlet.UUID)
		if (1 <= id && id <= NOUTPUTS) {
			this.status[id] = state
			const service = this.findConfigured(id)
			if (service) service.updateCharacteristic(this.hap.Characteristic.On, state)
		}
	}

	// get on 
	private getOn(id: string, callback: CharacteristicGetCallback) {
		this.log.debug('Get Output On: ' + id);
		const iid = parseInt(id)
		callback(NO_ERRORS, (1 <= iid && iid <= NOUTPUTS) ? this.status[iid] : false); ``
	}

	// set on
	private setOn(id: number, service: Service, value: CharacteristicValue, callback: CharacteristicSetCallback) {
		this.log.debug('Set Output On: ' + service.subtype + ": value: " + value);

		// simulate read only by immediately reverting to current status
		setTimeout((service) => {
			this.updateOutput(id, (1 <= id && id <= NOUTPUTS) ? this.status[id] : false);
		}, 50, service);
		callback(NO_ERRORS);
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
	private findConfigured(id: number): Service | undefined {
		return this.configured.find(s => s.subtype === id.toString())
	}

	// find restored service
	private findRestored(uuid: string, id: number): Service | undefined {
		return this.restored.find(s => s.UUID === uuid && s.subtype === id.toString())
	}
}