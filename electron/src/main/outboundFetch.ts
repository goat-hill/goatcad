/**
 * Every request the app makes to the outside world, through Chromium's network
 * stack rather than Node's.
 *
 * Three things come with the stack and none of them with Node's fetch: the OS
 * proxy configuration, the OS certificate store, and a browser's TLS and HTTP/2
 * fingerprint. The last is what decides whether a manufacturer serves a
 * datasheet at all — ST's edge closed the connection on curl and on Node with
 * any header set, and served Chrome on the first request.
 *
 * The partition is in-memory and credentials are omitted, so nothing a vendor
 * sets rides into another request or survives a launch. Main-process only and
 * only after `app` is ready, which every caller already is; pure modules take
 * this as a parameter and tests hand them a stub.
 */
import { session } from 'electron'

const PARTITION = 'outbound'

export const outboundFetch = (
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> =>
  session
    .fromPartition(PARTITION, { cache: false })
    .fetch(input instanceof URL ? input.href : input, { ...init, credentials: 'omit' })
