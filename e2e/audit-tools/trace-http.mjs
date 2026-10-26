// Observe real fetch traffic without intercepting or replacing it. Record URLs only, no bodies/keys.
import { channel } from 'node:diagnostics_channel';
import { appendFileSync } from 'node:fs';
channel('undici:request:create').subscribe(({ request }) => {
  if (process.env.PQI_AUDIT_HTTP_LOG) appendFileSync(process.env.PQI_AUDIT_HTTP_LOG, JSON.stringify({method:request.method,url:String(request.origin)+request.path})+'\n');
});
