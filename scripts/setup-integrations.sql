-- Setup Integration Protocols (excluding Royco)

-- 1) Shadow Exchange (Sonic) - xUSD Liquidity Pools
INSERT INTO integration_protocols (protocol_name, integration_type, chain_id, contract_address, underlying_asset, metadata, is_active, created_at)
VALUES 
  -- Pool A (xUSD/HLP0)
  ('Shadow Exchange Pool A (xUSD/HLP0)', 'lp', 146, '0xdEE813F080f9128e52E38E9Ffef8B997F9544332', 'xUSD', 
   '{"token0": "xUSD", "token1": "HLP0", "pair_type": "uniswap_v2"}', true, NOW()),
  
  -- Pool B (xUSD/aSonUSDC)
  ('Shadow Exchange Pool B (xUSD/aSonUSDC)', 'lp', 146, '0xFEAd02Fb16eC3B2F6318dCa230198dB73E99428C', 'xUSD',
   '{"token0": "xUSD", "token1": "aSonUSDC", "pair_type": "uniswap_v2"}', true, NOW());

-- 2) Euler (Sonic) - xUSD Vault (ERC-4626)
INSERT INTO integration_protocols (protocol_name, integration_type, chain_id, contract_address, underlying_asset, metadata, is_active, created_at)
VALUES 
  ('Euler xUSD Vault', 'vault', 146, '0xdEBdAB749330bb976fD10dc52f9A452aaF029028', 'xUSD',
   '{"vault_type": "erc4626", "underlying": "xUSD"}', true, NOW());

-- 3) Silo Finance V2 - xUSD Markets (ERC-4626 receipts)
INSERT INTO integration_protocols (protocol_name, integration_type, chain_id, contract_address, underlying_asset, metadata, is_active, created_at)
VALUES 
  -- Sonic Market 118 (xUSD-scUSD)
  ('Silo V2 Market 118 (xUSD-scUSD)', 'vault', 146, '0x596aeF68A03a0E35c4D8e624fBbdB0df0862F172', 'xUSD',
   '{"vault_type": "erc4626", "market_id": 118, "pair": "xUSD-scUSD"}', true, NOW()),
  
  -- Sonic Market 112 (xUSD-USDC)
  ('Silo V2 Market 112 (xUSD-USDC)', 'vault', 146, '0x172a687c397E315DBE56ED78aB347D7743D0D4fa', 'xUSD',
   '{"vault_type": "erc4626", "market_id": 112, "pair": "xUSD-USDC"}', true, NOW()),
  
  -- Avalanche Market 129 (xUSD-USDC)
  ('Silo V2 Avalanche Market 129 (xUSD-USDC)', 'vault', 43114, '0xc380E5250d9718f8d9116Bc9d787A0229044e2EB', 'xUSD',
   '{"vault_type": "erc4626", "market_id": 129, "pair": "xUSD-USDC"}', true, NOW());

-- 4) Enclabs (Sonic) - xUSD Core Pool (cToken-like)
INSERT INTO integration_protocols (protocol_name, integration_type, chain_id, contract_address, underlying_asset, metadata, is_active, created_at)
VALUES 
  ('Enclabs Core Pool (vxUSD_Core)', 'lending', 146, '0x13d79435F306D155CA2b9Af77234c84f80506045', 'xUSD',
   '{"marketType": "cToken", "symbol": "vxUSD_Core", "underlying": "0x6202B9f02E30E5e1c62Cc01E4305450E5d83b926"}', true, NOW());

-- 5) Stability.market (Sonic) - Stream Market (Aave-compatible)
INSERT INTO integration_protocols (protocol_name, integration_type, chain_id, contract_address, underlying_asset, metadata, is_active, created_at)
VALUES 
  ('Stability Stream Market', 'lending', 146, '0x13d79435F306D155CA2b9Af77234c84f80506045', 'xUSD',
   '{"marketType": "aave", "poolAddress": "0x1f672BD230D0FC2Ee9A75D2037a92CC1225A4Ad8", "aTokenAddress": "0x13d79435F306D155CA2b9Af77234c84f80506045"}', true, NOW());

-- Note: Royco IAM is excluded as requested (custodied model needs special handling)