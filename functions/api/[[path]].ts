import { proxyToBackend } from '../../cloudflare/pages-proxy';

export const onRequest = proxyToBackend;
