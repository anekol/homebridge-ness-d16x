// Ness D8/16 Aux accessory helper

import { CharacteristicGetCallback, CharacteristicSetCallback, CharacteristicValue, HAP, Logger, PlatformAccessory, Service } from "homebridge";
import { AuxiliaryOutputsUpdate, OutputsUpdate } from 'nessclient/build/event'
import { AuxiliaryOutputType, OutputType } from 'nessclient/build/event-types'
import { NessD16x, OutputConfig } from './index'

const NO_ERRORS = null
const NAUXOUTPUTS = 8
const NOUTPUTS = 4
const MAXOUTPUTS = Math.max(NAUXOUTPUTS, NOUTPUTS)

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
		private readonly verboseLog: boolean,
		private readonly outputs: OutputConfig[],
	) {
		this.hap = platform.api.hap
		this.log = platform.log
		for (let i = 1; i <= MAXOUTPUTS; ++i) this.status[i] = false
	}

	// configure the accessory
	public configure(): void {
		// register restored services
		for (const s of this.accessory.services) {
			if (this.verboseLog)
				this.log.info('Restored service: ' + s.displayName + ' subtype: ' + s.subtype + ': ' + s.UUID)
			this.addRestored(s)
		}

		// configure the information service
		const info = this.accessory.getService(this.hap.Service.AccessoryInformation)
		if (info) {
			info.setCharacteristic(this.hap.Characteristic.Manufacturer, 'Ness')
			this.addConfigured(info)
		}

		// configure output services
		for (const output of this.outputs) {
			if (1 <= output.id && output.id <= NOUTPUTS) {
				const service = this.findRestored(this.hap.Service.Outlet.UUID, output.id)
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

	// update auxiliary outputs state
	public updateAuxilaryOutputs(event: AuxiliaryOutputsUpdate): void {
		// kludge because ness client 2.2.0 does not provide access to private member _outputs
		const outputs: AuxiliaryOutputType[] = JSON.parse(JSON.stringify(event))._outputs
		const status: boolean[] = []
		for (let i = 1; i <= NAUXOUTPUTS; ++i) status[i] = false
		for (const output of outputs) {
			let id = null
			switch (output) {
				case AuxiliaryOutputType.AUX_1: id = 1; break
				case AuxiliaryOutputType.AUX_2: id = 2; break
				case AuxiliaryOutputType.AUX_3: id = 3; break
				case AuxiliaryOutputType.AUX_4: id = 4; break
				case AuxiliaryOutputType.AUX_5: id = 5; break
				case AuxiliaryOutputType.AUX_6: id = 6; break
				case AuxiliaryOutputType.AUX_7: id = 7; break
				case AuxiliaryOutputType.AUX_8: id = 8; break
			}
			if (id) status[id] = true
		}
		for (let i = 1; i <= NAUXOUTPUTS; ++i) this.updateOutput(i, status[i])
	}

	// update output state
	public updateOutput(id: number, state: boolean): void {
		if (this.verboseLog)
			this.log.info("Update Output: id: " + id + " state: " + state)
		if (1 <= id && id <= MAXOUTPUTS) {
			this.status[id] = state
			const service = this.findConfigured(id)
			if (service) service.updateCharacteristic(this.hap.Characteristic.On, state)
		}
	}

	// update outputs state
	public updateOutputs(event: OutputsUpdate): void {
		// kludge because ness client 2.2.0 does not provide access to private member _outputs
		const outputs: OutputType[] = JSON.parse(JSON.stringify(event))._outputs
		const status: boolean[] = []
		for (let i = 1; i <= NOUTPUTS; ++i) status[i] = false
		for (const output of outputs) {
			let id = null
			switch (output) {
				case OutputType.AUX1: id = 1; break
				case OutputType.AUX2: id = 2; break
				case OutputType.AUX3: id = 3; break
				case OutputType.AUX4: id = 4; break
			}
			if (id) status[id] = true
		}
		for (let i = 1; i <= NOUTPUTS; ++i) this.updateOutput(i, status[i])
	}

	// get on 
	private getOn(id: string, callback: CharacteristicGetCallback) {
		if (this.verboseLog)
			this.log.info('Get Output On: ' + id);
		const iid = parseInt(id)
		callback(NO_ERRORS, (1 <= iid && iid <= MAXOUTPUTS) ? this.status[iid] : false); ``
	}

	// set on
	private setOn(id: number, service: Service, value: CharacteristicValue, callback: CharacteristicSetCallback) {
		if (this.verboseLog)
			this.log.info('Set Output On: ' + service.subtype + ": value: " + value);

		// simulate read only by immediately reverting to current status
		setTimeout(() => {
			this.updateOutput(id, (1 <= id && id <= MAXOUTPUTS) ? this.status[id] : false);
		}, 50);
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