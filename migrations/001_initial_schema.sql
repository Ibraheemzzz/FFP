-- migrations/001_initial_schema.sql

-- 1. Plans table
CREATE TABLE plans (
    id VARCHAR(64) PRIMARY KEY CHECK (length(trim(id)) > 0),
    name VARCHAR(100) NOT NULL CHECK (length(trim(name)) > 0),
    type VARCHAR(10) NOT NULL CHECK (type IN ('ACCOUNT', 'USER')),
    monthly_limit BIGINT NOT NULL CHECK (monthly_limit >= 0 AND monthly_limit <= 9007199254740991),
    per_request_limit BIGINT NOT NULL CHECK (per_request_limit >= 0 AND per_request_limit <= 9007199254740991),
    owner_account_id VARCHAR(64) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Accounts table
CREATE TABLE accounts (
    id VARCHAR(64) PRIMARY KEY CHECK (length(trim(id)) > 0),
    name VARCHAR(100) NOT NULL CHECK (length(trim(name)) > 0),
    api_key_hash CHAR(64) NOT NULL UNIQUE CHECK (api_key_hash ~ '^[0-9a-fA-F]{64}$'),
    plan_id VARCHAR(64) NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Foreign key for custom plan ownership
ALTER TABLE plans 
    ADD CONSTRAINT fk_plans_owner_account 
    FOREIGN KEY (owner_account_id) REFERENCES accounts(id) ON DELETE RESTRICT;

-- 3. Users table
CREATE TABLE users (
    id VARCHAR(64) PRIMARY KEY CHECK (length(trim(id)) > 0),
    account_id VARCHAR(64) NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    plan_id VARCHAR(64) NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
    external_id VARCHAR(100) NULL CHECK (external_id IS NULL OR length(trim(external_id)) > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_users_account_id UNIQUE (account_id, id),
    CONSTRAINT uq_users_account_external UNIQUE (account_id, external_id)
);

-- 4. Account monthly usage counters
CREATE TABLE account_monthly_usage (
    account_id VARCHAR(64) NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    year_month CHAR(7) NOT NULL CHECK (year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    total_units BIGINT NOT NULL DEFAULT 0 CHECK (total_units >= 0 AND total_units <= 9007199254740991),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, year_month)
);

-- 5. User monthly usage counters
CREATE TABLE user_monthly_usage (
    account_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    year_month CHAR(7) NOT NULL CHECK (year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    total_units BIGINT NOT NULL DEFAULT 0 CHECK (total_units >= 0 AND total_units <= 9007199254740991),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, year_month),
    CONSTRAINT fk_user_monthly_usage_user 
        FOREIGN KEY (account_id, user_id) 
        REFERENCES users(account_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_user_monthly_usage_account ON user_monthly_usage(account_id, year_month);

-- 6. Consumption records and historical decisions
CREATE TABLE consumption_records (
    id BIGSERIAL PRIMARY KEY,
    account_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    request_id VARCHAR(128) NOT NULL CHECK (length(trim(request_id)) > 0),
    requested_units BIGINT NOT NULL CHECK (requested_units > 0 AND requested_units <= 9007199254740991),
    status VARCHAR(10) NOT NULL CHECK (status IN ('ACCEPTED', 'REJECTED')),
    rejection_scope VARCHAR(10) NULL CHECK (rejection_scope IN ('account', 'user')),
    rejection_rule VARCHAR(30) NULL CHECK (rejection_rule IN ('monthly_allowance', 'max_per_request')),
    response_body JSONB NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_consumption_account_request UNIQUE (account_id, request_id),
    CONSTRAINT fk_consumption_user 
        FOREIGN KEY (account_id, user_id) 
        REFERENCES users(account_id, id) ON DELETE RESTRICT,
    CONSTRAINT chk_consumption_rejection_consistency CHECK (
        (status = 'ACCEPTED' AND rejection_scope IS NULL AND rejection_rule IS NULL)
        OR
        (status = 'REJECTED' AND rejection_scope IS NOT NULL AND rejection_rule IS NOT NULL)
    )
);

CREATE INDEX idx_consumption_records_history ON consumption_records(account_id, processed_at DESC, id DESC);
