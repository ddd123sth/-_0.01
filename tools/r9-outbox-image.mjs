// Scheduler receipt bodies have no reader outside ackOutbox. Its durable
// confirmed prefix is sufficient to reject re-consumption, including replay
// after receipt retirement. Other consumers and all gaps remain untouched.
const TASK = 'retire:scheduler-confirmed-receipts/v1';
const quote = text => "'" + text.replaceAll("'", "''") + "'";
// Some stopped/removed-account consumers predate compact progress roots. Their
// actual successful callback receipts can establish a prefix without running
// that account, acknowledging a hole or using an old scan cursor as authority.
export function recoverLegacyReceiptPrefixes({ read, write, progress, frozen, deadline, save }) {
  const task = 'recover:legacy-scheduler-receipt-prefixes/v1', prior = progress(task);
  const detail = JSON.parse(prior?.detail_json || '{"created":0,"checked":0,"chainSha3":""}');
  if (prior?.done === 1) return { done: true, ...detail };
  const consumers = read(`SELECT r.consumer_id,e.owner_ref,e.subject_ref,max(r.event_id) AS maximum
    FROM backend_outbox_receipts r JOIN backend_outbox e ON e.event_id=r.event_id
    WHERE e.subject_ref IS NOT NULL AND substr(r.consumer_id,1,length('scheduler:'||e.owner_ref||':'||e.subject_ref||':'))=
      'scheduler:'||e.owner_ref||':'||e.subject_ref||':'
    AND length(r.consumer_id)>length('scheduler:'||e.owner_ref||':'||e.subject_ref||':')
    AND NOT EXISTS(SELECT 1 FROM backend_outbox_confirmed_progress c WHERE c.consumer_id=r.consumer_id AND c.owner_ref=e.owner_ref AND c.subject_ref=e.subject_ref)
    GROUP BY r.consumer_id,e.owner_ref,e.subject_ref ORDER BY r.consumer_id,e.owner_ref,e.subject_ref;`);
  let cursor = prior?.last_rowid ?? 0;
  while (cursor < consumers.length && Date.now() < deadline - 5000) {
    frozen(); const one = consumers[cursor], consumer = quote(one.consumer_id), owner = quote(one.owner_ref), subject = quote(one.subject_ref);
    const output = write(`BEGIN;
      CREATE TEMP TABLE _r9_prefix(through_id INTEGER,confirmed_at TEXT,n INTEGER,hash TEXT);
      CREATE TEMP TABLE _r9_prefix_assert(ok INTEGER CHECK(ok=1));
      INSERT INTO _r9_prefix(through_id) SELECT COALESCE((SELECT MIN(e.event_id)-1 FROM src.backend_outbox e
        WHERE e.owner_ref=${owner} AND e.subject_ref=${subject} AND e.event_id<=${one.maximum}
        AND NOT EXISTS(SELECT 1 FROM src.backend_outbox_receipts r WHERE r.consumer_id=${consumer} AND r.event_id=e.event_id)),${one.maximum});
      UPDATE _r9_prefix SET confirmed_at=(SELECT max(r.consumed_at) FROM src.backend_outbox_receipts r JOIN src.backend_outbox e ON e.event_id=r.event_id
        WHERE r.consumer_id=${consumer} AND e.owner_ref=${owner} AND e.subject_ref=${subject} AND r.event_id<=through_id),
        n=(SELECT count(*) FROM src.backend_outbox e WHERE e.owner_ref=${owner} AND e.subject_ref=${subject} AND e.event_id<=through_id);
      INSERT INTO _r9_prefix_assert SELECT NOT EXISTS(SELECT 1 FROM src.backend_outbox e,_r9_prefix p
        WHERE e.owner_ref=${owner} AND e.subject_ref=${subject} AND e.event_id<=p.through_id AND NOT EXISTS(
          SELECT 1 FROM src.backend_outbox_receipts r WHERE r.consumer_id=${consumer} AND r.event_id=e.event_id));
      UPDATE _r9_prefix SET hash=hex(sha3_query(${quote(`SELECT r.consumer_id,r.event_id,r.consumed_at,r.receipt_json FROM src.backend_outbox_receipts r JOIN src.backend_outbox e ON e.event_id=r.event_id CROSS JOIN _r9_prefix p WHERE r.consumer_id=${consumer} AND e.owner_ref=${owner} AND e.subject_ref=${subject} AND r.event_id<=p.through_id ORDER BY r.event_id`)},256));
      INSERT OR IGNORE INTO backend_outbox_confirmed_progress SELECT ${consumer},${owner},${subject},through_id,through_id,confirmed_at
        FROM _r9_prefix WHERE n>0 AND confirmed_at IS NOT NULL;
      INSERT INTO backend_r9_image_progress SELECT ${quote(task)},${cursor + 1},${Number(cursor + 1 === consumers.length)},
        json_object('created',${detail.created}+changes(),'checked',${detail.checked}+1,'chainSha3',hex(sha3(${quote(detail.chainSha3)}||hash,256))) FROM _r9_prefix WHERE 1
        ON CONFLICT(task) DO UPDATE SET last_rowid=excluded.last_rowid,done=excluded.done,detail_json=excluded.detail_json;
      COMMIT; SELECT detail_json FROM backend_r9_image_progress WHERE task=${quote(task)};`);
    Object.assign(detail, JSON.parse(output[0].detail_json)); cursor++;
    save('status', { state: 'recovering-actual-legacy-consumer-prefixes', cursor, maximum: consumers.length, ...detail, originalUntouched: true });
  }
  if (!consumers.length) write(`INSERT OR IGNORE INTO backend_r9_image_progress VALUES(${quote(task)},0,1,${quote(JSON.stringify(detail))});`);
  return { done: cursor === consumers.length, ...detail };
}
export function retireConfirmedReceiptImage({ read, write, progress, frozen, deadline, save }) {
  const prior = progress(TASK);
  let cursor = prior?.last_rowid ?? 0, detail = JSON.parse(prior?.detail_json || '{"retired":0,"batches":0,"chainSha3":""}');
  if (prior?.done === 1) return { done: true, ...detail };
  const invalid = read(`SELECT count(*) AS n FROM backend_outbox_scan_pending h JOIN backend_outbox_confirmed_progress c
    ON c.consumer_id=h.consumer_id AND c.owner_ref=h.owner_ref AND c.subject_ref=h.subject_ref WHERE h.event_id<=c.confirmed_through;`)[0].n;
  if (invalid) throw new Error('A claimed confirmation prefix contains an unconfirmed hole; preserve every receipt');
  const maximum = read('SELECT COALESCE(MAX(rowid),0) AS n FROM backend_outbox_receipts;')[0].n;
  while (cursor < maximum && Date.now() < deadline - 5000) {
    frozen();
    const end = read(`SELECT MAX(id) AS id FROM(SELECT rowid AS id FROM backend_outbox_receipts
      WHERE rowid>${cursor} ORDER BY rowid LIMIT 16384);`)[0].id;
    if (!Number.isSafeInteger(end) || end <= cursor) throw new Error('Receipt retirement cursor did not advance');
    const hashQuery = `SELECT r.rowid,r.consumer_id,r.event_id,r.consumed_at,r.receipt_json
      FROM src.backend_outbox_receipts r JOIN _r9_retire_ids i ON i.id=r.rowid ORDER BY r.rowid`;
    const output = write(`BEGIN;
      CREATE TEMP TABLE _r9_retire_ids(id INTEGER PRIMARY KEY);
      CREATE TEMP TABLE _r9_retire_proof(n INTEGER NOT NULL,hash TEXT NOT NULL);
      CREATE TEMP TABLE _r9_retire_assert(ok INTEGER CHECK(ok=1));
      INSERT INTO _r9_retire_ids SELECT r.rowid FROM src.backend_outbox_receipts r
        JOIN src.backend_outbox e ON e.event_id=r.event_id JOIN main.backend_outbox_confirmed_progress c
        ON c.consumer_id=r.consumer_id AND c.owner_ref=e.owner_ref AND c.subject_ref=e.subject_ref
        WHERE r.rowid>${cursor} AND r.rowid<=${end} AND r.event_id<=c.confirmed_through
        AND substr(r.consumer_id,1,length('scheduler:'||e.owner_ref||':'||e.subject_ref||':'))=
          'scheduler:'||e.owner_ref||':'||e.subject_ref||':'
        AND length(r.consumer_id)>length('scheduler:'||e.owner_ref||':'||e.subject_ref||':');
      INSERT INTO _r9_retire_proof SELECT (SELECT count(*) FROM _r9_retire_ids),hex(sha3_query(${quote(hashQuery)},256));
      DELETE FROM main.backend_outbox_receipts WHERE rowid IN(SELECT id FROM _r9_retire_ids);
      INSERT INTO _r9_retire_assert SELECT changes()=(SELECT n FROM _r9_retire_proof);
      INSERT INTO backend_r9_image_progress SELECT ${quote(TASK)},${end},${Number(end === maximum)},
        json_object('retired',${detail.retired}+n,'batches',${detail.batches}+1,
          'chainSha3',hex(sha3(${quote(detail.chainSha3)}||hash,256))) FROM _r9_retire_proof WHERE 1
        ON CONFLICT(task) DO UPDATE SET last_rowid=excluded.last_rowid,done=excluded.done,detail_json=excluded.detail_json;
      COMMIT;
      SELECT detail_json FROM backend_r9_image_progress WHERE task=${quote(TASK)};`);
    detail = JSON.parse(output[0].detail_json); cursor = end;
    save('status', { state: 'retiring-confirmed-scheduler-receipts', cursor, maximum, ...detail, originalUntouched: true });
  }
  if (!maximum) write(`INSERT OR IGNORE INTO backend_r9_image_progress VALUES(${quote(TASK)},0,1,'{"retired":0,"batches":0,"chainSha3":""}');`);
  return { done: cursor === maximum, ...detail };
}
