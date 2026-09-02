import { expect, test } from 'bun:test';
import type { Request } from 'express';

import { admitTrustedWebsiteRequest } from './TrustedWebsiteAdmission';

function request(remoteAddress: string, path = '/scrape/html-js'): Request {
  return {
    baseUrl: '/api/operators/website',
    path,
    socket: { remoteAddress },
  } as Request;
}

test('admits both trusted seats without a reusable bearer', () => {
  expect(admitTrustedWebsiteRequest(request('::ffff:100.122.151.60'), undefined)).toEqual({
    kind: 'direct-seat',
    identity: '100.122.151.60',
  });
  expect(admitTrustedWebsiteRequest(request('100.66.252.122'), undefined)).toEqual({
    kind: 'direct-seat',
    identity: '100.66.252.122',
  });
});

test('refuses an unapproved Tailnet identity on the fixed scrape routes', () => {
  expect(admitTrustedWebsiteRequest(request('100.95.48.39'), undefined)).toEqual({
    kind: 'refused',
  });
});

test('does not expand identity admission to other routes or public addresses', () => {
  expect(admitTrustedWebsiteRequest(request('100.122.151.60', '/crawl'), undefined)).toEqual({
    kind: 'not-applicable',
  });
  expect(admitTrustedWebsiteRequest(request('203.0.113.10'), undefined)).toEqual({
    kind: 'not-applicable',
  });
});
