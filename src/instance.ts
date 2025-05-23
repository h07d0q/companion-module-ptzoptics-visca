import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'
import DigestClient from 'digest-fetch'
import { getActions } from './actions/actions.js'
import { getConfigFields, type PtzOpticsConfig } from './config.js'
import {
	canUpdateOptionsWithoutRestarting,
	noCameraOptions,
	optionsFromConfig,
	type PtzOpticsOptions,
} from './options.js'
import { getPresets } from './presets.js'
import { repr } from './utils/repr.js'
import type { Command, CommandParameters, CommandParamValues, NoCommandParameters } from './visca/command.js'
import type { Answer, AnswerParameters, Inquiry } from './visca/inquiry.js'
import { VISCAPort } from './visca/port.js'

export class PtzOpticsInstance extends InstanceBase<PtzOpticsConfig> {
	/** Options dictating the behavior of this instance. */
	#options: PtzOpticsOptions = noCameraOptions()
	tallyPollTimer: NodeJS.Timeout | null = null

	/** Whether debug logging is enabled on this instance or not. */
	get debugLogging(): boolean {
		return this.#options.debugLogging
	}

	/** A port to use to communicate with the represented camera. */
	#visca = new VISCAPort(this)

	/**
	 * Send the given command to the camera, filling in any parameters from the
	 * specified options.  The options must be compatible with the command's
	 * parameters.
	 *
	 * @param command
	 *    The command to send.
	 * @param paramValues
	 *    A parameter values object compatible with this command's parameters
	 *    and their types.  (This can be omitted if the command lacks
	 *    parameters.)
	 */
	sendCommand<CmdParameters extends CommandParameters>(
		command: Command<CmdParameters>,
		...paramValues: CmdParameters extends NoCommandParameters
			? [CommandParamValues<CmdParameters>?]
			: [CommandParamValues<CmdParameters>]
	): void {
		// `sendCommand` implicitly waits for the connection to be fully
		// established, so it's unnecessary to resolve `this.#visca.connect()`
		// here.
		this.#visca.sendCommand(command, ...paramValues).then(
			(result: void | Error) => {
				if (typeof result === 'undefined') {
					return
				}

				this.log('error', `Error processing command: ${result.message}`)
			},
			(reason: Error) => {
				// Swallow the error so that execution gracefully unwinds.
				this.log('error', `Unhandled command rejection was suppressed: ${reason}`)
				return
			},
		)
	}

	/**
	 * Send the given inquiry to the camera.
	 *
	 * @param inquiry
	 *    The inquiry to send.
	 * @returns
	 *    A promise that resolves after the response to `inquiry` (which may be
	 *    an error response) has been processed.  If `inquiry`'s response was an
	 *    an error not implicating overall connection stability, the promise
	 *    resolves null.  Otherwise it resolves an object whose properties are
	 *    choices corresponding to the parameters in the response.
	 */
	async sendInquiry<Parameters extends AnswerParameters>(
		inquiry: Inquiry<Parameters>,
	): Promise<Answer<Parameters> | null> {
		// `sendInquiry` implicitly waits for the connection to be fully
		// established, so it's unnecessary to resolve `this.#visca.connect()`
		// here.
		return this.#visca.sendInquiry(inquiry).then(
			(result: Answer<Parameters> | Error) => {
				if (result instanceof Error) {
					this.log('error', `Error processing inquiry: ${result.message}`)
					return null
				}

				return result
			},
			(reason: Error) => {
				// Swallow the error so that execution gracefully unwinds.
				this.log('error', `Unhandled inquiry rejection was suppressed: ${reason}`)
				return null
			},
		)
	}

	/**
	 * Send HTTP/CGI command to the camera.
	 */
	#digestClient: DigestClient | null = null
	#digestClient2: DigestClient | null = null

	async sendHTTPCommand<T = unknown>(path: string, method: 'GET' | 'POST' = 'GET'): Promise<T> {
		if (!this.#digestClient) {
			const username = this.#options.HTTPusername
			const password = this.#options.HTTPpassword
			this.#digestClient = new DigestClient(username, password, {
				algorithm: 'SHA-256',
				headers: {
					'User-Agent': 'Mozilla/5.0',
					Accept: 'application/json',
				},
			})
		}

		const url = 'http://' + `${this.#options.host}${path}`
		const response = (await this.#digestClient.fetch(url, {
			method,
			body: method === 'POST' ? '' : undefined,
			data: '',
		})) as Response
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`)
		}

		const contentType = response.headers.get('content-type') || ''
		if (contentType.includes('application/json')) {
			return response.json() as Promise<T>
		} else {
			// HTML, text or XML-fallback
			const text = await response.text()
			const data = this.#parseAttributeString(text)
			if (Object.keys(data).length > 0) {
				return { data } as unknown as T
			}
			try {
				return JSON.parse(text)
			} catch {
				throw new Error(`Unexpected content type: ${contentType}, and could not parse response`)
			}
		}
	}

	#parseAttributeString(input: string): Record<string, string> {
		const result: Record<string, string> = {}
		const regex = /(\w+)\s*=\s*"([^"]*)"/g
		let match

		while ((match = regex.exec(input)) !== null) {
			const key = match[1]
			const value = match[2]
			result[key] = value
		}

		return result
	}

	/**
	 * The speed to be passed in the pan/tilt speed parameters of Pan Tilt Drive
	 * VISCA commands.  Ranges between 0x01 (low speed) and 0x18 (high speed).
	 * However, as 0x15-0x18 are valid only for panning, tilt speed is capped at
	 * 0x14.
	 */
	#speed = 0x0c

	panTiltSpeed(): { panSpeed: number; tiltSpeed: number } {
		return {
			panSpeed: this.#speed,
			tiltSpeed: Math.min(this.#speed, 0x14),
		}
	}

	setPanTiltSpeed(speed: number): void {
		if (0x01 <= speed && speed <= 0x18) {
			this.#speed = speed
		} else {
			this.log('debug', `speed ${speed} unexpectedly not in range [0x01, 0x18]`)
			this.#speed = 0x0c
		}
	}

	increasePanTiltSpeed(): void {
		if (this.#speed < 0x18) this.#speed++
	}

	decreasePanTiltSpeed(): void {
		if (this.#speed > 0x01) this.#speed--
	}

	override getConfigFields(): SomeCompanionConfigField[] {
		return getConfigFields()
	}

	override async destroy(): Promise<void> {
		this.log('info', `destroying module: ${this.id}`)
		if (this.tallyPollTimer) {
			clearInterval(this.tallyPollTimer)
			this.tallyPollTimer = null
		}
		this.#visca.close('Instance is being destroyed', InstanceStatus.Disconnected)
	}

	override async init(config: PtzOpticsConfig): Promise<void> {
		this.#logConfig(config, 'init()')

		this.setActionDefinitions(getActions(this))
		this.setPresetDefinitions(getPresets())
		return this.configUpdated(config)
	}

	override async configUpdated(config: PtzOpticsConfig): Promise<void> {
		this.#logConfig(config, 'configUpdated()')

		const oldOptions = this.#options

		const newOptions = optionsFromConfig(config)
		this.#options = newOptions

		if (canUpdateOptionsWithoutRestarting(oldOptions, newOptions)) {
			return
		}

		if (this.#options.host === null) {
			this.#visca.close('no host specified', InstanceStatus.Disconnected)
		} else {
			// Initiate the connection (closing any prior connection), but don't
			// delay to fully establish it as `await this.#visca.connect()`
			// would, because network vagaries might make this take a long time.
			this.#visca.open(this.#options.host, this.#options.port)

			// HTTP Status
			if (this.tallyPollTimer) {
				clearInterval(this.tallyPollTimer)
				this.tallyPollTimer = null
			}
			const username = config.HTTPusername
			const password = config.HTTPpassword
			let variableDefinitions: { variableId: string; name: string }[] = []
			let variableValues: Record<string, string | number | boolean> = {}
			let model = ''
			let devVersion = ''
			// get some informations at start
			if (username && password) {
				// device config
				try {
					const result = await this.sendHTTPCommand<{ data: any }>('/cgi-bin/param.cgi?get_device_conf')

					if (result?.data) {
						variableDefinitions = [
							{
								name: 'HTTP Device Name',
								variableId: 'HTTPdevname',
							},
							{
								name: 'HTTP Device Version',
								variableId: 'HTTPdevVersion',
							},
							{
								name: 'HTTP Serial Number',
								variableId: 'HTTPserialNum',
							},
							{
								name: 'HTTP Device Model',
								variableId: 'HTTPdeviceModel',
							},
						]
						result.data.device_model = result.data.device_model.trim()
						model = result.data.device_model
						devVersion = result.data.versioninfo
						variableValues = {
							HTTPdevname: result.data.devname,
							HTTPdevVersion: devVersion,
							HTTPserialNum: result.data.serial_num,
							HTTPdeviceModel: result.data.device_model,
						}
					}
				} catch (err) {
					this.log('error', `device config fetch failed: ${err}`)
				}
				// check firmware version
				try {
					this.#digestClient2 = new DigestClient('', '')
					const result = (await this.#digestClient2.fetch(`https://firmware.ptzoptics.com/${model}/RVU.json`, {
						method: 'GET',
						headers: {
							'User-Agent': 'Mozilla/5.0',
							Accept: 'application/json',
						},
					})) as Response
					if (!result.ok) {
						throw new Error(`HTTP ${result.status}`)
					}
					const text = await result.text()
					let parsed: any
					try {
						parsed = JSON.parse(text)
					} catch {
						throw new Error(`Unexpected content type, could not parse JSON.`)
					}
					devVersion = devVersion.split(' v')[1] || ''
					variableDefinitions.push({ name: 'HTTP Device Updateable', variableId: 'HTTPdevUpdateable' })
					if (parsed.data.soc_version !== devVersion) {
						this.log(
							'info',
							`Firmware update from ${devVersion} to ${parsed.data.soc_version} available. Changelog: https://firmware.ptzoptics.com/${model}/${parsed.data.log_name}`,
						)
						variableValues = { ...variableValues, HTTPdevUpdateable: parsed.data.soc_version }
					} else {
						variableValues = { ...variableValues, HTTPdevUpdateable: 0 }
					}
				} catch (err) {
					this.log('error', `PTZ Firmware fetch failed: ${err}`)
				}
			}
			// start tally-polling, if interval > 0
			const interval = Number(config.HTTPpollInterval)
			if (interval > 0 && username && password) {
				let isRequestInProgress = false
				let firstRun = true
				this.tallyPollTimer = setInterval(() => {
					void (async () => {
						if (isRequestInProgress) return // skip if already/still running
						// Get tally status
						try {
							isRequestInProgress = true
							const result = await this.sendHTTPCommand<{ data: any }>('/cgi-bin/param.cgi?get_tally_status', 'GET')
							if (result?.data) {
								if (firstRun) {
									for (const key of Object.keys(result.data)) {
										const varId = `HTTP${key}`
										variableDefinitions.push({
											name: `HTTP ${key}`,
											variableId: varId,
										})
									}
								}
								for (const [key, value] of Object.entries(result.data)) {
									variableValues[`HTTP${key}`] = String(value)
								}
							}
						} catch (err) {
							this.log('error', `Tally fetch failed: ${err}`)
						} finally {
							isRequestInProgress = false
						}
						// Get advanced image config 
						try {
							isRequestInProgress = true
							const result = await this.sendHTTPCommand<{ data: any }>(
								'/cgi-bin/param.cgi?get_advance_image_conf',
								'GET',
							)
							if (result?.data) {
								if (firstRun) {
									for (const key of Object.keys(result.data)) {
										const varId = `HTTPimage_${key}`
										variableDefinitions.push({
											name: `HTTP image ${key}`,
											variableId: varId,
										})
									}
								}
								for (const [key, value] of Object.entries(result.data)) {
									variableValues[`HTTPimage_${key}`] = String(value)
								}
							}
						} catch (err) {
							this.log('error', `Image fetch failed: ${err}`)
						} finally {
							isRequestInProgress = false
						}
						if (firstRun) {
							firstRun = false
							this.setVariableDefinitions(variableDefinitions)
						}
						this.setVariableValues(variableValues)
					})()
				}, interval)
			} else {
				this.setVariableDefinitions(variableDefinitions)
				this.setVariableValues(variableValues)
			}
		}
	}

	/**
	 * Write a copy of the given module config information to logs.
	 *
	 * @param config
	 *   The config information to log.
	 * @param desc
	 *   A description of the event occasioning the logging.
	 */
	#logConfig(config: PtzOpticsConfig, desc = 'logConfig()'): void {
		this.log('info', `PTZOptics module configuration on ${desc}: ${repr(config)}`)
	}
}
