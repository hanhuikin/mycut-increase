-- =====================================================================
-- MyCut 数据库初始化脚本（DDL + DML）
-- =====================================================================
-- 目标数据库：PostgreSQL 14+（开发环境为 postgres:18，Docker 容器 pg18）
-- 字符编码  ：UTF8
-- Schema    ：app（应用私有 schema；PostgreSQL 15+ 下非超级用户无权在
--             public 建表，故代码统一使用 app schema，见 src/db/schema.ts）
--
-- 生成方式  ：DDL 由 pg_dump --schema-only 从真实库导出（与 drizzle-kit
--             push 的结果一致），DML 与代码内运行时 seed 完全对应：
--             · app.ai_models  ← services/admin/models.ts  DEFAULT_MODELS
--             · app.channels   ← services/admin/channels.ts DEFAULT_CHANNELS
--
-- 使用方法  ：
--   createdb -U <user> appdb
--   psql -U <user> -d appdb -f 数据库配置.sql
--
-- 注意事项  ：
--   · DML 为「全新安装基线」：渠道不带密钥（api_key_enc 为空串，需在
--     管理面板 /admin/channels 里填入），ai-audio-musicgen 默认停用，
--     均与代码 seed 行为一致。已有环境请勿重放 DML 覆盖线上配置。
--   · 幂等性：DML 均带 ON CONFLICT DO NOTHING，可重复执行。
--   · better-auth 相关表（users/sessions/accounts/verifications/
--     two_factors）只建结构，不预置数据；用户与密码须经应用注册产生
--     （密码哈希由 better-auth 生成）。
-- =====================================================================

--
-- PostgreSQL database dump
--

\restrict eu97jxntn8xay19It4tiHvSLy7JZFclpe59YlNH5Jh9GME8DjXmYQl8UNIFbUYr

-- Dumped from database version 18.6 (Debian 18.6-1.pgdg13+2)
-- Dumped by pg_dump version 18.6 (Debian 18.6-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: app; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA app;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: accounts; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.accounts (
    id text NOT NULL,
    issuer text DEFAULT ''::text NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp without time zone,
    refresh_token_expires_at timestamp without time zone,
    scope text,
    password text,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL
);


--
-- Name: ai_models; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.ai_models (
    id text NOT NULL,
    label text NOT NULL,
    kind text NOT NULL,
    price_per_second_720 integer,
    price_per_second_1080 integer,
    price_per_call integer,
    daily_limit integer,
    enabled boolean DEFAULT true NOT NULL,
    requires_pro boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    updated_at timestamp without time zone NOT NULL,
    modes jsonb DEFAULT '[]'::jsonb NOT NULL,
    supports_audio boolean DEFAULT false NOT NULL,
    max_duration integer DEFAULT 15 NOT NULL,
    label_key text,
    description_key text
);


--
-- Name: audit_log; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.audit_log (
    id text NOT NULL,
    actor_id text,
    actor_email text DEFAULT ''::text NOT NULL,
    action text NOT NULL,
    target text DEFAULT ''::text NOT NULL,
    detail text DEFAULT ''::text NOT NULL,
    ip text DEFAULT ''::text NOT NULL,
    created_at timestamp without time zone NOT NULL
);


--
-- Name: channels; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.channels (
    id text NOT NULL,
    name text NOT NULL,
    protocol text NOT NULL,
    base_url text DEFAULT ''::text NOT NULL,
    api_key_enc text DEFAULT ''::text NOT NULL,
    api_key_suffix text DEFAULT ''::text NOT NULL,
    models jsonb DEFAULT '{}'::jsonb NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_by text DEFAULT ''::text NOT NULL,
    updated_by text DEFAULT ''::text NOT NULL,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL
);


--
-- Name: credit_ledger; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.credit_ledger (
    id text NOT NULL,
    user_id text NOT NULL,
    amount integer NOT NULL,
    balance_after integer NOT NULL,
    kind text NOT NULL,
    ref_id text,
    note text DEFAULT ''::text NOT NULL,
    actor_id text,
    created_at timestamp without time zone NOT NULL,
    model_id text,
    seconds integer
);


--
-- Name: feedback; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.feedback (
    id text NOT NULL,
    message text NOT NULL,
    created_at timestamp without time zone NOT NULL
);


--
-- Name: redeem_codes; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.redeem_codes (
    code text NOT NULL,
    credits integer NOT NULL,
    batch_id text NOT NULL,
    redeemed_by text,
    redeemed_at timestamp without time zone,
    created_at timestamp without time zone NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.sessions (
    id text NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    token text NOT NULL,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL,
    ip_address text,
    user_agent text,
    user_id text NOT NULL
);


--
-- Name: two_factors; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.two_factors (
    id text NOT NULL,
    secret text NOT NULL,
    backup_codes text NOT NULL,
    user_id text NOT NULL
);


--
-- Name: user_model_grants; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.user_model_grants (
    user_id text NOT NULL,
    model_id text NOT NULL,
    granted_by text,
    created_at timestamp without time zone NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.users (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    role text DEFAULT 'user'::text NOT NULL,
    plan text DEFAULT 'free'::text NOT NULL,
    banned boolean DEFAULT false NOT NULL,
    ban_reason text,
    ban_expires timestamp without time zone,
    two_factor_enabled boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL
);


--
-- Name: verifications; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.verifications (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    created_at timestamp without time zone,
    updated_at timestamp without time zone
);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: ai_models ai_models_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.ai_models
    ADD CONSTRAINT ai_models_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: channels channels_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.channels
    ADD CONSTRAINT channels_pkey PRIMARY KEY (id);


--
-- Name: credit_ledger credit_ledger_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.credit_ledger
    ADD CONSTRAINT credit_ledger_pkey PRIMARY KEY (id);


--
-- Name: feedback feedback_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.feedback
    ADD CONSTRAINT feedback_pkey PRIMARY KEY (id);


--
-- Name: redeem_codes redeem_codes_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.redeem_codes
    ADD CONSTRAINT redeem_codes_pkey PRIMARY KEY (code);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_token_unique; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.sessions
    ADD CONSTRAINT sessions_token_unique UNIQUE (token);


--
-- Name: two_factors two_factors_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.two_factors
    ADD CONSTRAINT two_factors_pkey PRIMARY KEY (id);


--
-- Name: users users_email_unique; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: verifications verifications_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.verifications
    ADD CONSTRAINT verifications_pkey PRIMARY KEY (id);


--
-- Name: audit_log_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX audit_log_created_idx ON app.audit_log USING btree (created_at);


--
-- Name: channels_enabled_priority_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX channels_enabled_priority_idx ON app.channels USING btree (enabled, priority);


--
-- Name: credit_ledger_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX credit_ledger_created_idx ON app.credit_ledger USING btree (created_at);


--
-- Name: credit_ledger_idem_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX credit_ledger_idem_idx ON app.credit_ledger USING btree (kind, ref_id);


--
-- Name: credit_ledger_user_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX credit_ledger_user_idx ON app.credit_ledger USING btree (user_id, created_at);


--
-- Name: accounts accounts_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.accounts
    ADD CONSTRAINT accounts_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE CASCADE;


--
-- Name: credit_ledger credit_ledger_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.credit_ledger
    ADD CONSTRAINT credit_ledger_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE CASCADE;


--
-- Name: redeem_codes redeem_codes_redeemed_by_users_id_fk; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.redeem_codes
    ADD CONSTRAINT redeem_codes_redeemed_by_users_id_fk FOREIGN KEY (redeemed_by) REFERENCES app.users(id) ON DELETE SET NULL;


--
-- Name: sessions sessions_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.sessions
    ADD CONSTRAINT sessions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE CASCADE;


--
-- Name: two_factors two_factors_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.two_factors
    ADD CONSTRAINT two_factors_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE CASCADE;


--
-- Name: user_model_grants user_model_grants_model_id_ai_models_id_fk; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_model_grants
    ADD CONSTRAINT user_model_grants_model_id_ai_models_id_fk FOREIGN KEY (model_id) REFERENCES app.ai_models(id) ON DELETE CASCADE;


--
-- Name: user_model_grants user_model_grants_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_model_grants
    ADD CONSTRAINT user_model_grants_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE CASCADE;


--
-- Name: accounts; Type: ROW SECURITY; Schema: app; Owner: -
--

ALTER TABLE app.accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_models; Type: ROW SECURITY; Schema: app; Owner: -
--

ALTER TABLE app.ai_models ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_log; Type: ROW SECURITY; Schema: app; Owner: -
--

ALTER TABLE app.audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: channels; Type: ROW SECURITY; Schema: app; Owner: -
--

ALTER TABLE app.channels ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_ledger; Type: ROW SECURITY; Schema: app; Owner: -
--

ALTER TABLE app.credit_ledger ENABLE ROW LEVEL SECURITY;

--
-- Name: redeem_codes; Type: ROW SECURITY; Schema: app; Owner: -
--

ALTER TABLE app.redeem_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: sessions; Type: ROW SECURITY; Schema: app; Owner: -
--

ALTER TABLE app.sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: two_factors; Type: ROW SECURITY; Schema: app; Owner: -
--

ALTER TABLE app.two_factors ENABLE ROW LEVEL SECURITY;

--
-- Name: user_model_grants; Type: ROW SECURITY; Schema: app; Owner: -
--

ALTER TABLE app.user_model_grants ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: app; Owner: -
--

ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;

--
-- Name: verifications; Type: ROW SECURITY; Schema: app; Owner: -
--

ALTER TABLE app.verifications ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict eu97jxntn8xay19It4tiHvSLy7JZFclpe59YlNH5Jh9GME8DjXmYQl8UNIFbUYr


-- =====================================================================
-- DML：运行时 seed 数据（全新安装基线）
-- =====================================================================

-- ---------------------------------------------------------------------
-- 模型目录（services/admin/models.ts · DEFAULT_MODELS）
-- ---------------------------------------------------------------------
INSERT INTO app.ai_models (
    id, label, kind, modes, supports_audio, max_duration,
    price_per_second_720, price_per_second_1080, price_per_call,
    label_key, description_key, daily_limit, enabled, requires_pro,
    sort_order, updated_at
) VALUES
    ('seedance-2.0', 'Seedance 2.0', 'video',
     '["text-to-video","image-to-video"]'::jsonb, true, 15,
     10, 25, NULL,
     'ai_video.model_seedance', 'ai_video.model_seedance_desc', NULL,
     true, false, 0, now()),
    ('seedance-2.0-turbo', 'Seedance 2.0 Turbo', 'video',
     '["text-to-video"]'::jsonb, false, 10,
     5, NULL, NULL,
     'ai_video.model_seedance_turbo', 'ai_video.model_seedance_turbo_desc', NULL,
     true, false, 1, now()),
    ('ai-tools-remove-bg', 'AI 抠像', 'tool',
     '[]'::jsonb, false, 15,
     NULL, NULL, 30,
     NULL, NULL, NULL,
     true, false, 2, now()),
    ('ai-tools-inpaint', 'AI 擦除', 'tool',
     '[]'::jsonb, false, 15,
     NULL, NULL, 50,
     NULL, NULL, NULL,
     true, false, 3, now()),
    ('ai-audio-musicgen', 'MusicGen 音频', 'audio',
     '[]'::jsonb, false, 30,
     NULL, NULL, 20,
     NULL, NULL, NULL,
     false, false, 4, now()),
    ('whisper-local', 'Whisper 转写', 'local',
     '[]'::jsonb, false, 15,
     NULL, NULL, NULL,
     NULL, NULL, NULL,
     true, false, 5, now())
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 默认渠道（services/admin/channels.ts · DEFAULT_CHANNELS）
-- 密钥为空：需在管理面板逐一填入后渠道才会参与路由
-- ---------------------------------------------------------------------
INSERT INTO app.channels (
    id, name, protocol, base_url, api_key_enc, api_key_suffix,
    models, priority, enabled, created_by, updated_by, created_at, updated_at
) VALUES
    (gen_random_uuid()::text, '火山方舟', 'ark', '', '', '',
     '{"seedance-2.0":"doubao-seedance-2-0-260128"}'::jsonb,
     0, true, 'system', 'system', now(), now()),
    (gen_random_uuid()::text, 'Atlas Cloud', 'atlas', '', '', '',
     '{"seedance-2.0":"bytedance/seedance-2.0/text-to-video","seedance-2.0-turbo":"bytedance/seedance-2.0/text-to-video"}'::jsonb,
     10, true, 'system', 'system', now(), now()),
    (gen_random_uuid()::text, 'WaveSpeedAI', 'wavespeed', '', '', '',
     '{"seedance-2.0":"bytedance/seedance-2.0/text-to-video-turbo","seedance-2.0-turbo":"bytedance/seedance-2.0/text-to-video-turbo"}'::jsonb,
     20, true, 'system', 'system', now(), now()),
    (gen_random_uuid()::text, 'fal.ai', 'fal-queue', '', '', '',
     '{"seedance-2.0":"bytedance/seedance-2.0/text-to-video","seedance-2.0-turbo":"bytedance/seedance-2.0/text-to-video","ai-tools-remove-bg":"fal-ai/birefnet","ai-tools-inpaint":"fal-ai/flux-lora/inpainting","ai-audio-musicgen":"fal-ai/musicgen"}'::jsonb,
     30, true, 'system', 'system', now(), now())
ON CONFLICT (id) DO NOTHING;
