DO $$
DECLARE
    item jsonb;
    affected integer;
BEGIN
    IF (SELECT count(*) FROM asset_import) <> 1 THEN
        RAISE EXCEPTION 'Expected exactly one asset record';
    END IF;
    SELECT payload INTO item FROM asset_import;
    IF jsonb_typeof(item) <> 'object' THEN
        RAISE EXCEPTION 'Asset record must be a JSON object';
    END IF;
    IF NOT coalesce((item->>'valuation') ~ '^[0-9]+$', false)
        OR NOT coalesce((item->>'chain_id') ~ '^[0-9]+$', false)
        OR NOT coalesce((item->>'creation_block') ~ '^[0-9]+$', false) THEN
        RAISE EXCEPTION 'valuation, chain_id, and creation_block must be whole-number strings';
    END IF;
    INSERT INTO public.assets (
        asset_id, name, description, asset_type, valuation, currency,
        metadata_uri, metadata, document_hash, token_address, issuer_address,
        factory_address, chain_id, creation_transaction_hash, creation_block
    ) VALUES (
        item->>'asset_id', item->>'name', coalesce(item->>'description', ''),
        item->>'asset_type', (item->>'valuation')::numeric, item->>'currency',
        coalesce(item->>'metadata_uri', ''), item->'metadata', lower(item->>'document_hash'),
        lower(item->>'token_address'), lower(item->>'issuer_address'), lower(item->>'factory_address'),
        (item->>'chain_id')::numeric, lower(item->>'creation_transaction_hash'), (item->>'creation_block')::bigint
    )
    ON CONFLICT (chain_id, asset_id) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description,
        asset_type = EXCLUDED.asset_type, valuation = EXCLUDED.valuation, currency = EXCLUDED.currency,
        metadata_uri = EXCLUDED.metadata_uri, metadata = EXCLUDED.metadata,
        document_hash = EXCLUDED.document_hash, updated_at = now()
    WHERE assets.token_address = EXCLUDED.token_address
        AND assets.issuer_address = EXCLUDED.issuer_address
        AND assets.factory_address = EXCLUDED.factory_address
        AND assets.creation_transaction_hash = EXCLUDED.creation_transaction_hash
        AND assets.creation_block = EXCLUDED.creation_block;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'Existing asset has different deployment details; refusing to replace its blockchain link';
    END IF;
END $$;
SELECT asset_id, name, chain_id, token_address, issuer_address
FROM public.assets
WHERE chain_id = (SELECT (payload->>'chain_id')::numeric FROM asset_import)
    AND asset_id = (SELECT payload->>'asset_id' FROM asset_import);
