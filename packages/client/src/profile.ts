import {
  normalizeApiBaseUrl,
  type NormalizeApiBaseUrlOptions,
  type ProprApiBaseUrl,
} from './baseUrl.js';
import { ProprClientError } from './errors.js';

export type ProprInstanceAuthentication = 'session' | 'bearer' | 'none';

/** Serializable instance metadata. Credentials and persistence intentionally live elsewhere. */
export interface ProprInstanceProfile {
  id: string;
  name: string;
  /** Empty or omitted selects the browser's current origin. */
  apiBaseUrl?: string;
  authentication: ProprInstanceAuthentication;
  allowInsecureHttp?: boolean;
}

export interface NormalizedProprInstanceProfile extends Omit<ProprInstanceProfile, 'apiBaseUrl'> {
  apiBaseUrl: ProprApiBaseUrl;
}

const validateLabel = (value: string, field: 'id' | 'name'): string => {
  const normalized = value.trim();
  const maximum = field === 'id' ? 128 : 200;
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ProprClientError(`The instance ${field} is invalid.`, { kind: 'configuration' });
  }
  return normalized;
};

export const normalizeInstanceProfile = (
  profile: ProprInstanceProfile,
  options: NormalizeApiBaseUrlOptions = {}
): NormalizedProprInstanceProfile => {
  if (!['session', 'bearer', 'none'].includes(profile.authentication)) {
    throw new ProprClientError('The instance authentication mode is invalid.', {
      kind: 'configuration',
    });
  }
  return {
    ...profile,
    id: validateLabel(profile.id, 'id'),
    name: validateLabel(profile.name, 'name'),
    apiBaseUrl: normalizeApiBaseUrl(profile.apiBaseUrl, {
      allowInsecureHttp: profile.allowInsecureHttp ?? options.allowInsecureHttp,
    }),
  };
};
