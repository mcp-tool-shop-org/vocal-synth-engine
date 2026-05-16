import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('version alignment', () => {
  let pkg: any;
  let pkgRaw: string;

  // TS-009: surface a malformed package.json as a test failure with a
  // meaningful message, rather than a top-level file-load stack trace.
  beforeAll(() => {
    pkgRaw = readFileSync(join(__dirname, '..', 'package.json'), 'utf-8');
    pkg = JSON.parse(pkgRaw);
  });

  it('package.json is valid JSON', () => {
    expect(() => JSON.parse(pkgRaw)).not.toThrow();
  });

  it('package.json version is semver', () => {
    const parts = pkg.version.split('.');
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(Number.isInteger(Number(part))).toBe(true);
    }
  });

  // TS-003: tighten substring match to a Keep-a-Changelog release heading
  // anchored to start-of-line so '1.0.30' / 'commit abc1.0.3xyz' /
  // '[Unreleased]' alone do NOT satisfy the assertion.
  it('CHANGELOG has a Keep-a-Changelog heading for current version', () => {
    const changelog = readFileSync(join(__dirname, '..', 'CHANGELOG.md'), 'utf-8');
    const escapedVersion = pkg.version.replace(/\./g, '\\.');
    const headingPattern = new RegExp(
      '^##\\s*\\[' + escapedVersion + '\\]',
      'm'
    );
    expect(changelog).toMatch(headingPattern);
  });

  it('package name uses @mcptoolshop scope', () => {
    expect(pkg.name).toMatch(/^@mcptoolshop\//);
  });
});
