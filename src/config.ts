import { type InputValue, Regex, type SomeCompanionConfigField } from '@companion-module/base'

/**
 * The `TConfig` object type used to store instance configuration info.
 *
 * Nothing ensures that Companion config objects conform to the `TConfig` type
 * specified by a module.  Therefore we leave this type underdefined, not
 * well-defined, so that configuration info will be defensively processed.  (We
 * use `PtzOpticsOptions` to store configuration choices as well-typed values
 * for the long haul.  See the `options.ts:optionsFromConfig` destructuring
 * parameter for a list of the field/types we expect to find in config objects.)
 */
export interface PtzOpticsConfig {
	[key: string]: InputValue | undefined
}

/** The id of the debug-logging config option. */
export const DebugLoggingOptionId = 'debugLogging'

/**
 * A config option was added in 3.0.0 to turn on extra logging to Companion's
 * logs, to make it easier to debug the module in case of error.  Add a default
 * value for that option to older configs.
 */
export function tryUpdateConfigWithDebugLogging(config: PtzOpticsConfig | null): boolean {
	if (config !== null && !(DebugLoggingOptionId in config)) {
		config[DebugLoggingOptionId] = false
		return true
	}

	return false
}

export function getConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'static-text',
			id: 'info',
			width: 12,
			label: 'Information',
			value:
				'This module controls PTZ cameras using VISCA over TCP/IP. (Some additional functions are performed over password-protected HTTP.)',
		},
		{
			type: 'textinput',
			id: 'host',
			label: 'Camera IP',
			width: 6,
			default: '',
			regex: Regex.IP,
			required: true,
		},
		{
			type: 'textinput',
			id: 'port',
			label: 'VISCA TCP port',
			width: 6,
			default: '5678',
			regex: Regex.PORT,
			required: true,
		},
		{
			type: 'number',
			id: 'httpPollInterval',
			label: 'HTTP Status poll interval (ms, 0 = disabled)',
			width: 6,
			default: 0,
			min: 0,
			max: 60000,
			step: 100,
		},
		{
			type: 'textinput',
			id: 'httpUsername',
			label: 'Username',
			width: 6,
			default: 'admin',
		},
		{
			type: 'textinput',
			id: 'httpPassword',
			label: 'Password',
			width: 6,
			default: '',
		},
		{
			type: 'checkbox',
			id: DebugLoggingOptionId,
			label: 'Log extra info during connection operations, for debugging purposes',
			default: false,
			width: 6,
		},
	]
}
