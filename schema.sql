-- ============================================================
-- 実験室予約システム — データベースセットアップ
-- Supabase SQL Editor に全体を貼り付けて「Run」してください
-- ============================================================

-- ============================================================
-- テーブル
-- ============================================================

CREATE TABLE IF NOT EXISTS rooms (
  id            SERIAL PRIMARY KEY,
  name          TEXT    NOT NULL DEFAULT '実験室',
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reservations (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    INTEGER     NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  purpose    TEXT        NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time   TIMESTAMPTZ NOT NULL,
  created_by UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT end_after_start CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_res_room_time
  ON reservations(room_id, start_time, end_time);

CREATE TABLE IF NOT EXISTS profiles (
  id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email        TEXT,
  display_name TEXT,
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- トリガー：ユーザー作成時に自動でプロフィールを作成
-- ============================================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  BEGIN
    INSERT INTO public.profiles (id, email, role)
    VALUES (NEW.id, NEW.email, 'member')
    ON CONFLICT (id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'handle_new_user skipped: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ============================================================
-- ヘルパー関数
-- ============================================================
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    (SELECT role = 'admin' FROM profiles WHERE id = auth.uid()),
    false
  )
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================
-- 重複予約防止トリガー
-- ============================================================
CREATE OR REPLACE FUNCTION prevent_reservation_overlap()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM reservations
    WHERE  room_id    = NEW.room_id
    AND    id        != COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
    AND    start_time < NEW.end_time
    AND    end_time   > NEW.start_time
  ) THEN
    RAISE EXCEPTION 'RESERVATION_OVERLAP';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reservation_overlap ON reservations;
CREATE TRIGGER trg_reservation_overlap
  BEFORE INSERT OR UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION prevent_reservation_overlap();

-- ============================================================
-- Row Level Security
-- ============================================================
ALTER TABLE rooms        ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles     ENABLE ROW LEVEL SECURITY;

-- 既存ポリシーを削除（再実行できるように）
DROP POLICY IF EXISTS "auth_rooms"               ON rooms;
DROP POLICY IF EXISTS "auth_reservations"        ON reservations;
DROP POLICY IF EXISTS "res_select"               ON reservations;
DROP POLICY IF EXISTS "res_insert"               ON reservations;
DROP POLICY IF EXISTS "res_delete"               ON reservations;
DROP POLICY IF EXISTS "auth_profiles_select"     ON profiles;
DROP POLICY IF EXISTS "allow_insert_profiles"    ON profiles;
DROP POLICY IF EXISTS "admin_profiles_update"    ON profiles;
DROP POLICY IF EXISTS "self_update_profile"      ON profiles;

-- 部屋：ログイン済みなら読み書き可
CREATE POLICY "auth_rooms" ON rooms
  FOR ALL USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

-- 予約：参照・作成はログイン済み全員、削除は管理者か作成者のみ
CREATE POLICY "res_select" ON reservations
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "res_insert" ON reservations
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "res_delete" ON reservations
  FOR DELETE USING (is_admin() OR created_by = auth.uid());

-- プロフィール：参照はログイン済み全員
CREATE POLICY "auth_profiles_select" ON profiles
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- プロフィール：トリガーからの INSERT を許可
CREATE POLICY "allow_insert_profiles" ON profiles
  FOR INSERT WITH CHECK (true);

-- プロフィール：管理者はすべて更新可
CREATE POLICY "admin_profiles_update" ON profiles
  FOR UPDATE USING (is_admin()) WITH CHECK (is_admin());

-- プロフィール：本人は表示名のみ更新可（role は変更不可）
CREATE POLICY "self_update_profile" ON profiles
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid() AND
    role = (SELECT role FROM profiles WHERE id = auth.uid())
  );

-- ============================================================
-- Realtime 有効化
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'reservations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE reservations;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'rooms'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE rooms;
  END IF;
END $$;

-- ============================================================
-- デフォルト部屋を1つ作成
-- ============================================================
INSERT INTO rooms (name, display_order)
VALUES ('実験室', 0)
ON CONFLICT DO NOTHING;
