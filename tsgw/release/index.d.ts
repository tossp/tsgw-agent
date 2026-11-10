export const PACKAGE_NAME: string;
export const COMMAND_NAME: string;
export const REPOSITORY_URL: string;
export function isReleaseVersion(version: unknown): version is string;
export function getReleaseChannel(version: string): "next" | "latest";
export function readReleaseVersion(metadata: unknown, currentVersion: string): string;
export function getNpmLatestUrl(version: string): string;
export function isNewerReleaseVersion(candidate: string, current: string): boolean;
export function getReleaseUrl(version: string): string | null;
