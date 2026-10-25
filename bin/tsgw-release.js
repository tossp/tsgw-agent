"use strict";

// Shared by the installed CLI and the web update endpoint. Package identity is
// persisted in package.json; only the version changes for a CI preview build.
/* eslint-disable @typescript-eslint/no-require-imports */
const semver = require("semver");
const manifest = require("../package.json");

const PACKAGE_NAME = manifest.name;
const COMMAND_NAME = Object.keys(manifest.bin)[0];
const REPOSITORY_URL = manifest.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");

function isReleaseVersion(version) {
  return typeof version === "string" && semver.valid(version) === version;
}

function getReleaseChannel(version) {
  if (!isReleaseVersion(version)) throw new Error("Invalid release version");
  return semver.prerelease(version) ? "next" : "latest";
}

function readReleaseVersion(metadata, currentVersion) {
  if (!metadata || typeof metadata !== "object" || metadata.name !== PACKAGE_NAME
    || !isReleaseVersion(metadata.version)
    || getReleaseChannel(metadata.version) !== getReleaseChannel(currentVersion)) {
    throw new Error("npm registry returned unexpected package or release channel");
  }
  return metadata.version;
}

function getNpmLatestUrl(version) {
  return `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/${getReleaseChannel(version)}`;
}

function isNewerReleaseVersion(candidate, current) {
  return isReleaseVersion(candidate) && isReleaseVersion(current)
    && getReleaseChannel(candidate) === getReleaseChannel(current)
    && semver.gt(candidate, current);
}

function getReleaseUrl(version) {
  if (!isReleaseVersion(version)) return null;
  return getReleaseChannel(version) === "next"
    ? `${REPOSITORY_URL}/tree/tsgw`
    : `${REPOSITORY_URL}/tree/v${version}`;
}

module.exports = {
  PACKAGE_NAME, COMMAND_NAME, REPOSITORY_URL, isReleaseVersion,
  getReleaseChannel, readReleaseVersion, getNpmLatestUrl, isNewerReleaseVersion, getReleaseUrl,
};
