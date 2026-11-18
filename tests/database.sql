\set ON_ERROR_STOP on
BEGIN;
UPDATE internal.batches SET status='failed',lease_token=NULL,leased_until=NULL WHERE status IN('queued','processing');
DO $$
DECLARE u jsonb;cfg jsonb;rows jsonb;b jsonb;j jsonb;bid uuid;token uuid;value bigint;inv_id uuid;stats jsonb;
BEGIN
 u:=api.save_upload('test.csv',repeat('a',64),'{"format":"csv","sheets":[{"name":"CSV","headers":["sku","name","qty","price"],"rows":[]}]}');
 cfg:='{"supplier":"SQL Supplier","reference":"ONE","mode":"add","currency":"USD","date":"2026-11-18","sheet":0,"mapping":{"sku":0,"name":1,"quantity":2,"unit_price":3,"currency":null,"effective_date":null}}';
 rows:='[{"row_number":2,"original":["A","Item A","5","1.00"],"data":{"sku":"A","name":"Item A","quantity":5,"unit_price_minor":100,"currency":"USD","effective_date":"2026-11-18"},"errors":[]},{"row_number":3,"original":["B","Bad","-1","1.00"],"data":null,"errors":[{"field":"quantity","code":"INVALID_QUANTITY","message":"Invalid"}]}]';
 BEGIN PERFORM api.create_batch((u->>'id')::uuid,cfg,rows,repeat('b',64),false);RAISE EXCEPTION 'Partial import accepted without opt-in';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 b:=api.create_batch((u->>'id')::uuid,cfg,rows,repeat('b',64),true);bid:=(b->>'id')::uuid;
 IF api.create_batch((u->>'id')::uuid,cfg,rows,repeat('b',64),true)->>'duplicate'<>'true' THEN RAISE EXCEPTION 'Duplicate batch was not recognized';END IF;
 BEGIN PERFORM api.create_batch((u->>'id')::uuid,cfg,rows,repeat('c',64),true);RAISE EXCEPTION 'Reference conflict accepted';EXCEPTION WHEN unique_violation THEN NULL;END;
 j:=api.claim_batch();token:=(j->>'token')::uuid;
 IF j->>'id'<>bid::text OR api.claim_batch()IS NOT NULL THEN RAISE EXCEPTION 'Claim exclusivity failed';END IF;
 IF api.apply_batch(bid,gen_random_uuid())THEN RAISE EXCEPTION 'Invalid lease accepted';END IF;
 IF api.apply_batch(bid,token)IS DISTINCT FROM true THEN RAISE EXCEPTION 'Valid import rejected';END IF;
 IF api.apply_batch(bid,token)THEN RAISE EXCEPTION 'Completed import applied twice';END IF;
 SELECT quantity,id INTO value,inv_id FROM internal.inventory WHERE supplier_key='sql supplier'AND sku='A';
 IF value<>5 THEN RAISE EXCEPTION 'Wrong imported stock';END IF;
 SELECT b1.stats INTO stats FROM internal.batches b1 WHERE b1.id=bid;
 IF stats->>'created'<>'1'OR stats->>'invalid'<>'1' THEN RAISE EXCEPTION 'Wrong partial results';END IF;
 cfg:=jsonb_set(cfg,'{reference}','"TWO"');b:=api.create_batch((u->>'id')::uuid,cfg,rows,repeat('d',64),true);j:=api.claim_batch();
 UPDATE internal.batches SET leased_until=now()-interval '1 second'WHERE batches.id=(b->>'id')::uuid;
 token:=(j->>'token')::uuid;j:=api.claim_batch();
 IF api.apply_batch((b->>'id')::uuid,token)THEN RAISE EXCEPTION 'Expired worker committed';END IF;
 PERFORM api.apply_batch((b->>'id')::uuid,(j->>'token')::uuid);
 SELECT quantity INTO value FROM internal.inventory WHERE inventory.id=inv_id;IF value<>10 THEN RAISE EXCEPTION 'Add did not apply exactly once';END IF;
 -- An older replacement snapshot must not downgrade quantity.
 cfg:=jsonb_set(jsonb_set(cfg,'{reference}','"OLDER"'),'{mode}','"replace"');rows:=jsonb_set(rows,'{0,data,effective_date}','"2026-11-17"');
 b:=api.create_batch((u->>'id')::uuid,cfg,rows,repeat('e',64),true);j:=api.claim_batch();PERFORM api.apply_batch((b->>'id')::uuid,(j->>'token')::uuid);
 SELECT quantity INTO value FROM internal.inventory WHERE inventory.id=inv_id;IF value<>10 THEN RAISE EXCEPTION 'Older stock snapshot applied';END IF;
 -- A live inventory conflict must roll back the ENTIRE strict batch.
 INSERT INTO internal.inventory(supplier_key,supplier,sku,name,quantity,unit_price_minor,currency,effective_date,last_batch_id)
 VALUES('sql supplier','SQL Supplier','B','Existing foreign-currency item',1,100,'EUR','2026-11-18',(b->>'id')::uuid);
 cfg:=jsonb_set(jsonb_set(cfg,'{reference}','"STRICT"'),'{mode}','"add"');
 rows:='[{"row_number":2,"original":[],"data":{"sku":"A","name":"Item A","quantity":5,"unit_price_minor":100,"currency":"USD","effective_date":"2026-11-18"},"errors":[]},{"row_number":3,"original":[],"data":{"sku":"B","name":"Item B","quantity":5,"unit_price_minor":100,"currency":"USD","effective_date":"2026-11-18"},"errors":[]}]';
 b:=api.create_batch((u->>'id')::uuid,cfg,rows,repeat('f',64),false);j:=api.claim_batch();
 BEGIN PERFORM api.apply_batch((b->>'id')::uuid,(j->>'token')::uuid);RAISE EXCEPTION 'Strict conflict did not abort';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 SELECT quantity INTO value FROM internal.inventory WHERE inventory.id=inv_id;IF value<>10 THEN RAISE EXCEPTION 'Strict conflict left partial writes';END IF;
 IF EXISTS(SELECT 1 FROM internal.changes WHERE batch_id=(b->>'id')::uuid)THEN RAISE EXCEPTION 'Rolled-back changes remained in audit';END IF;
 PERFORM api.fail_batch((b->>'id')::uuid,(j->>'token')::uuid);
 -- Final-attempt crashes terminate and can be explicitly retried.
 cfg:=jsonb_set(cfg,'{reference}','"RECOVERY"');rows:=jsonb_build_array(rows->0);
 b:=api.create_batch((u->>'id')::uuid,cfg,rows,repeat('1',64),false);j:=api.claim_batch();
 UPDATE internal.batches SET attempts=3,leased_until=now()-interval '1 second'WHERE batches.id=(b->>'id')::uuid;
 PERFORM api.claim_batch();
 IF(SELECT status FROM internal.batches WHERE batches.id=(b->>'id')::uuid)<>'failed'THEN RAISE EXCEPTION 'Final lease expiry did not fail';END IF;
 PERFORM api.retry_batch((b->>'id')::uuid);j:=api.claim_batch();PERFORM api.apply_batch((b->>'id')::uuid,(j->>'token')::uuid);
 SELECT quantity INTO value FROM internal.inventory WHERE inventory.id=inv_id;IF value<>15 THEN RAISE EXCEPTION 'Recovery failed';END IF;
 IF has_table_privilege('stockroom_app','internal.inventory','UPDATE')OR has_schema_privilege('stockroom_app','internal','USAGE')THEN RAISE EXCEPTION 'Raw data writes exposed';END IF;
 RAISE NOTICE 'PASS: partial opt-in, idempotency, reference conflicts, lease exclusivity, duplicate completion, additive stock and stale snapshot guard';
END $$;
ROLLBACK;
