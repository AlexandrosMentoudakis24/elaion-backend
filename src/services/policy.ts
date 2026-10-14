import { ValidationError } from "../errors/app-errors.js";

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
export const MAX_USERNAME_LENGTH = 64;

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Usernames are case-sensitive identities in the contract, but they must not
 * be trivially confusable: `Admin` and `admin` would otherwise be two accounts
 * nobody meant to create. Normalisation happens on write; lookups use the
 * same normalisation.
 */
export const normalizeUsername = (raw: string): string => raw.trim().toLowerCase();

export const assertUsernamePolicy = (username: string): string => {
  const normalized = normalizeUsername(username);
  if (normalized.length < 3 || normalized.length > MAX_USERNAME_LENGTH) {
    throw new ValidationError(
      `Field "username" must be between 3 and ${MAX_USERNAME_LENGTH} characters`,
    );
  }
  if (!USERNAME_PATTERN.test(normalized)) {
    throw new ValidationError(
      'Field "username" must start with a letter or digit and contain only lowercase letters, digits, ".", "_", "-"',
    );
  }
  return normalized;
};

export const assertPasswordPolicy = (password: string): void => {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new ValidationError(
      `Field "password" must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`,
    );
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw new ValidationError('Field "password" must contain letters and digits');
  }
  if (/^(.)\1+$/.test(password)) {
    throw new ValidationError('Field "password" must not be a single repeated character');
  }
};
