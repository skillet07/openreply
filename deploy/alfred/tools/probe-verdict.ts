// PASS/FAIL rule of zernio-signed-probe.ts, kept free of I/O so a test can cover it.

export interface ProbeObservation {
  signedStatus: number;
  wrongSignatureStatus: number;
  storedEvent: boolean;
  dmRows: number;
  /** BullMQ state of the job the webhook queued for the synthetic comment; 'missing' if there is none. */
  jobState: string;
}

/** The worker must have finished the job: a stored WebhookEvent only proves the job was queued. */
export function probeVerdict(o: ProbeObservation): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  if (o.signedStatus !== 200) failures.push(`signed request answered ${o.signedStatus}, expected 200`);
  if (o.wrongSignatureStatus !== 401) failures.push(`wrongly signed request answered ${o.wrongSignatureStatus}, expected 401`);
  if (!o.storedEvent) failures.push('webhook event was not stored');
  if (o.dmRows !== 0) failures.push(`${o.dmRows} DM log row(s) exist for the synthetic comment, expected 0`);
  if (o.jobState !== 'completed') failures.push(`queue job is "${o.jobState}", expected "completed" (is the worker running?)`);
  return { pass: failures.length === 0, failures };
}
