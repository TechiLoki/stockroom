CREATE SCHEMA internal;
CREATE SCHEMA api;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA api REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE internal.uploads(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),filename text NOT NULL,hash text NOT NULL UNIQUE,parsed jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE internal.batches(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),upload_id uuid NOT NULL REFERENCES internal.uploads,
 supplier_key text NOT NULL,supplier text NOT NULL,reference text NOT NULL,fingerprint text NOT NULL,config jsonb NOT NULL,rows jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','completed','failed')),
 attempts integer NOT NULL DEFAULT 0,lease_token uuid,leased_until timestamptz,
 stats jsonb,error text,allow_partial boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 UNIQUE(supplier_key,reference)
);
CREATE INDEX batch_queue ON internal.batches(created_at) WHERE status IN ('queued','processing');
CREATE TABLE internal.inventory(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),supplier_key text NOT NULL,supplier text NOT NULL,sku text NOT NULL,name text NOT NULL,
 quantity bigint NOT NULL CHECK(quantity BETWEEN 0 AND 1000000),unit_price_minor bigint NOT NULL CHECK(unit_price_minor BETWEEN 0 AND 1000000000000),currency text NOT NULL CHECK(currency IN ('USD','EUR','GBP','GEL','JPY','KWD')),
 effective_date date NOT NULL,last_batch_id uuid NOT NULL REFERENCES internal.batches,version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(supplier_key,sku)
);
CREATE TABLE internal.changes(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,batch_id uuid NOT NULL REFERENCES internal.batches,sku text NOT NULL,action text NOT NULL,before_value jsonb,after_value jsonb,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE internal.settings(id integer PRIMARY KEY CHECK(id=1),worker_seen timestamptz);
INSERT INTO internal.settings(id)VALUES(1);
CREATE FUNCTION api.ping() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT '{"ok":true}'::jsonb;$$;
CREATE FUNCTION api.save_upload(p_name text,p_hash text,p_parsed jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=internal,pg_temp AS $$
DECLARE u uploads;
BEGIN
 IF length(p_name) NOT BETWEEN 1 AND 200 OR p_hash !~ '^[0-9a-f]{64}$' OR jsonb_typeof(p_parsed->'sheets') IS DISTINCT FROM 'array' OR jsonb_array_length(p_parsed->'sheets') NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'Invalid upload' USING ERRCODE='22023';END IF;
 INSERT INTO uploads(filename,hash,parsed)VALUES(p_name,p_hash,p_parsed)ON CONFLICT(hash)DO NOTHING;
 SELECT * INTO u FROM uploads WHERE hash=p_hash;
 RETURN to_jsonb(u);
END $$;
CREATE FUNCTION api.get_upload(p_id uuid)RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=internal,pg_temp AS $$
DECLARE u uploads;
BEGIN SELECT * INTO u FROM uploads WHERE id=p_id;IF NOT FOUND THEN RAISE EXCEPTION 'Upload not found' USING ERRCODE='P0002';END IF;RETURN to_jsonb(u);END $$;
CREATE FUNCTION api.inventory_lookup(p_supplier text,p_skus jsonb)RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=internal,pg_temp AS $$
SELECT coalesce(jsonb_agg(to_jsonb(i)),'[]'::jsonb)FROM inventory i WHERE supplier_key=lower(trim(p_supplier))AND sku IN(SELECT jsonb_array_elements_text(p_skus));$$;
CREATE FUNCTION api.find_batch(p_supplier text,p_reference text)RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=internal,pg_temp AS $$
SELECT jsonb_build_object('id',id,'status',status,'fingerprint',fingerprint)FROM batches WHERE supplier_key=lower(trim(p_supplier))AND reference=upper(trim(p_reference));
$$;
CREATE FUNCTION api.create_batch(p_upload_id uuid,p_config jsonb,p_rows jsonb,p_fingerprint text,p_allow_partial boolean)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=internal,pg_temp AS $$
DECLARE b batches;key text;ref text;invalid integer;valid integer;
BEGIN
 key:=lower(trim(p_config->>'supplier'));ref:=upper(trim(p_config->>'reference'));
 IF length(key)NOT BETWEEN 1 AND 100 OR length(ref)NOT BETWEEN 1 AND 100 OR p_config->>'mode' NOT IN('replace','add') OR p_fingerprint !~ '^[0-9a-f]{64}$' OR jsonb_typeof(p_rows)IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows)NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'Invalid batch configuration' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('batch:'||key||':'||ref,0));
 SELECT * INTO b FROM batches WHERE supplier_key=key AND reference=ref;
 IF FOUND THEN
  IF b.fingerprint<>p_fingerprint THEN RAISE EXCEPTION 'Supplier reference already belongs to different content or settings' USING ERRCODE='23505';END IF;
  RETURN jsonb_build_object('id',b.id,'duplicate',true,'status',b.status);
 END IF;
 SELECT count(*) FILTER(WHERE jsonb_array_length(r->'errors')>0),count(*) FILTER(WHERE jsonb_array_length(r->'errors')=0 AND r->'data'<>'null'::jsonb)INTO invalid,valid FROM jsonb_array_elements(p_rows)r;
 IF valid=0 OR invalid>0 AND NOT p_allow_partial THEN RAISE EXCEPTION 'Correct invalid rows or explicitly allow valid-only import' USING ERRCODE='22023';END IF;
 INSERT INTO batches(upload_id,supplier_key,supplier,reference,fingerprint,config,rows,allow_partial)VALUES(p_upload_id,key,p_config->>'supplier',ref,p_fingerprint,p_config,p_rows,p_allow_partial)RETURNING * INTO b;
 RETURN jsonb_build_object('id',b.id,'duplicate',false,'status',b.status);
END $$;
CREATE FUNCTION api.claim_batch()RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=internal,pg_temp AS $$
DECLARE b batches;token uuid;
BEGIN
 UPDATE settings SET worker_seen=clock_timestamp()WHERE id=1;
 UPDATE batches SET status='failed',error='Worker lease expired on final attempt',lease_token=NULL,leased_until=NULL WHERE status='processing'AND leased_until<now()AND attempts>=3;
 SELECT * INTO b FROM batches WHERE(status='queued'OR status='processing'AND leased_until<now())AND attempts<3 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL;END IF;token:=gen_random_uuid();
 UPDATE batches SET status='processing',attempts=attempts+1,lease_token=token,leased_until=now()+interval '60 seconds',error=NULL WHERE id=b.id;
 RETURN jsonb_build_object('id',b.id,'token',token);
END $$;
CREATE FUNCTION api.apply_batch(p_id uuid,p_token uuid)RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=internal,pg_temp AS $$
DECLARE b batches;r jsonb;data jsonb;current_item inventory;after_item inventory;result jsonb:='[]';outcome text;message text;qty bigint;price bigint;day date;created integer:=0;updated integer:=0;unchanged integer:=0;stale integer:=0;invalid integer:=0;
BEGIN
 SELECT * INTO b FROM batches WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR b.status<>'processing'OR b.lease_token IS DISTINCT FROM p_token OR b.leased_until<clock_timestamp()THEN RETURN false;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('inventory:'||b.supplier_key,0));
 IF b.leased_until<clock_timestamp()THEN RETURN false;END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(b.rows)WITH ORDINALITY x(value,n)ORDER BY n LOOP
  message:=NULL;data:=r->'data';
  IF jsonb_array_length(r->'errors')>0 OR data='null'::jsonb THEN outcome:='invalid';invalid:=invalid+1;
  ELSE
   qty:=(data->>'quantity')::bigint;price:=(data->>'unit_price_minor')::bigint;day:=(data->>'effective_date')::date;
   IF qty NOT BETWEEN 0 AND 1000000 OR price NOT BETWEEN 0 AND 1000000000000 OR data->>'currency'NOT IN('USD','EUR','GBP','GEL','JPY','KWD')OR data->>'sku'!~'^[A-Z0-9][A-Z0-9._/-]{0,63}$'THEN RAISE EXCEPTION 'Invalid normalized row' USING ERRCODE='22023';END IF;
   SELECT * INTO current_item FROM inventory WHERE supplier_key=b.supplier_key AND sku=data->>'sku' FOR UPDATE;
   IF NOT FOUND THEN
    INSERT INTO inventory(supplier_key,supplier,sku,name,quantity,unit_price_minor,currency,effective_date,last_batch_id)VALUES(b.supplier_key,b.supplier,data->>'sku',data->>'name',qty,price,data->>'currency',day,b.id)RETURNING * INTO after_item;
    outcome:='created';created:=created+1;
    INSERT INTO changes(batch_id,sku,action,after_value)VALUES(b.id,data->>'sku',outcome,to_jsonb(after_item));
   ELSIF current_item.currency<>data->>'currency' THEN outcome:='invalid';message:='Existing SKU uses a different currency; conversion is never implicit.';invalid:=invalid+1;
   ELSIF b.config->>'mode'='replace'AND day<current_item.effective_date THEN outcome:='stale';stale:=stale+1;
   ELSE
    IF b.config->>'mode'='add' THEN qty:=qty+current_item.quantity;END IF;
    IF qty>1000000 THEN outcome:='invalid';message:='Resulting stock exceeds 1,000,000 units.';invalid:=invalid+1;
    ELSE
     IF b.config->>'mode'='add'AND day<current_item.effective_date THEN data:=jsonb_set(jsonb_set(data,'{name}',to_jsonb(current_item.name)),'{unit_price_minor}',to_jsonb(current_item.unit_price_minor));price:=current_item.unit_price_minor;END IF;
     day:=greatest(day,current_item.effective_date);
     IF qty=current_item.quantity AND price=current_item.unit_price_minor AND data->>'name'=current_item.name AND day=current_item.effective_date THEN outcome:='unchanged';unchanged:=unchanged+1;
     ELSE
      UPDATE inventory SET name=data->>'name',quantity=qty,unit_price_minor=price,effective_date=day,last_batch_id=b.id,version=version+1,updated_at=now()WHERE id=current_item.id RETURNING * INTO after_item;
      outcome:='updated';updated:=updated+1;
      INSERT INTO changes(batch_id,sku,action,before_value,after_value)VALUES(b.id,data->>'sku',outcome,to_jsonb(current_item),to_jsonb(after_item));
     END IF;
    END IF;
   END IF;
  END IF;
  IF message IS NOT NULL AND NOT b.allow_partial THEN RAISE EXCEPTION 'Inventory changed after preview; no rows were applied. Review the source and retry.' USING ERRCODE='22023';END IF;
  IF message IS NOT NULL THEN r:=jsonb_set(r,'{errors}',coalesce(r->'errors','[]')||jsonb_build_array(jsonb_build_object('field','inventory','code','APPLY_CONFLICT','message',message)));END IF;
  result:=result||jsonb_build_array(r||jsonb_build_object('outcome',outcome));
 END LOOP;
 UPDATE batches SET status='completed',rows=result,stats=jsonb_build_object('created',created,'updated',updated,'unchanged',unchanged,'stale',stale,'invalid',invalid),completed_at=now(),lease_token=NULL,leased_until=NULL WHERE id=b.id;
 RETURN true;
END $$;
CREATE FUNCTION api.fail_batch(p_id uuid,p_token uuid)RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=internal,pg_temp AS $$
BEGIN
 UPDATE batches SET status='failed',error='Import transaction failed; no partial inventory changes were committed. Review configuration and retry.',lease_token=NULL,leased_until=NULL WHERE id=p_id AND status='processing'AND lease_token=p_token;
 RETURN FOUND;
END $$;
CREATE FUNCTION api.retry_batch(p_id uuid)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=internal,pg_temp AS $$
BEGIN
 UPDATE batches SET status='queued',attempts=0,error=NULL WHERE id=p_id AND status='failed';IF NOT FOUND THEN RAISE EXCEPTION 'Only failed batches can be retried' USING ERRCODE='22023';END IF;RETURN '{"queued":true}'::jsonb;
END $$;
CREATE FUNCTION api.dashboard()RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=internal,pg_temp AS $$
SELECT jsonb_build_object('products',(SELECT count(*)FROM inventory),'units',(SELECT coalesce(sum(quantity),0)FROM inventory),'imports',(SELECT count(*)FROM batches),'pending',(SELECT count(*)FROM batches WHERE status IN('queued','processing')),'rejected_rows',(SELECT coalesce(sum((stats->>'invalid')::int),0)FROM batches),'worker_ready',coalesce(worker_seen>now()-interval '30 seconds',false))FROM settings WHERE id=1;
$$;
CREATE FUNCTION api.list_inventory(p_search text DEFAULT '',p_supplier text DEFAULT '',p_offset integer DEFAULT 0)RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=internal,pg_temp AS $$
WITH filtered AS(SELECT * FROM inventory WHERE(p_search=''OR sku ILIKE '%'||left(p_search,100)||'%'OR name ILIKE '%'||left(p_search,100)||'%')AND(p_supplier=''OR supplier_key=lower(trim(p_supplier)))),page AS(SELECT * FROM filtered ORDER BY updated_at DESC,id LIMIT 50 OFFSET greatest(0,least(p_offset,100000)))
SELECT jsonb_build_object('total',(SELECT count(*)FROM filtered),'items',coalesce((SELECT jsonb_agg(to_jsonb(page)ORDER BY updated_at DESC,id)FROM page),'[]'));
$$;
CREATE FUNCTION api.list_batches()RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=internal,pg_temp AS $$SELECT coalesce(jsonb_agg(to_jsonb(rows)ORDER BY created_at DESC),'[]')FROM(SELECT b.id,b.supplier,b.reference,b.status,b.stats,b.error,b.created_at,b.completed_at,u.filename,b.config->>'mode' AS mode FROM batches b JOIN uploads u ON u.id=b.upload_id ORDER BY b.created_at DESC LIMIT 100)rows;$$;
CREATE FUNCTION api.batch_details(p_id uuid)RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=internal,pg_temp AS $$
DECLARE b batches;
BEGIN SELECT * INTO b FROM batches WHERE id=p_id;IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found' USING ERRCODE='P0002';END IF;RETURN to_jsonb(b)||jsonb_build_object('changes',(SELECT coalesce(jsonb_agg(to_jsonb(c)ORDER BY id),'[]')FROM changes c WHERE batch_id=p_id));END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO stockroom_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA api TO stockroom_app;
