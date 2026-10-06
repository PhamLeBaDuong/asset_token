-- Run after 001-assets.sql. All fixture writes are rolled back.
BEGIN;
DO $$
DECLARE
    sample_id text := '__checkpoint_schema_test_' || txid_current()::text;
    token text := '0x' || md5(random()::text) || '12345678';
    new_id bigint;
BEGIN
    INSERT INTO public.assets (
        asset_id, name, description, asset_type, valuation, currency, metadata,
        document_hash, token_address, issuer_address, factory_address,
        chain_id, creation_transaction_hash, creation_block
    ) VALUES (
        sample_id, 'Coffee test', 'Owner''s coffee shop', 'Business',
        115792089237316195423570985008687907853269984665640564039457584007913129639935,
        'USD', '{"business":"Coffee","note":"Owner''s document"}'::jsonb,
        '0x' || repeat('0', 64), token, '0x' || repeat('1', 40), '0x' || repeat('2', 40),
        11155111, '0x' || repeat('3', 64), 42
    ) RETURNING id INTO new_id;
    IF (SELECT metadata->>'note' FROM public.assets WHERE id = new_id) <> 'Owner''s document' THEN
        RAISE EXCEPTION 'JSON metadata did not round-trip';
    END IF;
    BEGIN
        UPDATE public.assets SET token_address = 'bad-address' WHERE id = new_id;
        RAISE EXCEPTION 'Invalid address was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE public.assets SET metadata = '[]'::jsonb WHERE id = new_id;
        RAISE EXCEPTION 'Array metadata was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE public.assets SET valuation = -1 WHERE id = new_id;
        RAISE EXCEPTION 'Negative valuation was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE public.assets SET valuation = 1.5 WHERE id = new_id;
        RAISE EXCEPTION 'Fractional valuation was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE public.assets SET chain_id = 0 WHERE id = new_id;
        RAISE EXCEPTION 'Zero chain ID was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO public.assets (
            asset_id, name, asset_type, valuation, currency, document_hash,
            token_address, issuer_address, factory_address, chain_id,
            creation_transaction_hash, creation_block
        ) SELECT asset_id, name, asset_type, valuation, currency, document_hash,
            token_address, issuer_address, factory_address, chain_id,
            creation_transaction_hash, creation_block FROM public.assets WHERE id = new_id;
        RAISE EXCEPTION 'Duplicate deployment was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    -- An asset ID and address may repeat on another chain.
    INSERT INTO public.assets (
        asset_id, name, asset_type, valuation, currency, document_hash,
        token_address, issuer_address, factory_address, chain_id,
        creation_transaction_hash, creation_block
    ) SELECT asset_id, name, asset_type, valuation, currency, document_hash,
        token_address, issuer_address, factory_address, 31337,
        creation_transaction_hash, creation_block FROM public.assets WHERE id = new_id;
    RAISE NOTICE 'Asset schema checks passed';
END $$;
ROLLBACK;
