import { useEffect, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { canAccessMetering } from "./lib/access";
import { isSupabaseConfigured, supabase } from "./lib/supabase";
import { KanameterWorkspacePage } from "./pages/KanameterWorkspacePage";
import type { UserProfile } from "./types";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const client = supabase;
    if (!client) {
      setLoading(false);
      return;
    }
    const load = async (next: Session | null) => {
      setSession(next);
      if (!next) {
        setProfile(null);
        setLoading(false);
        return;
      }
      const { data } = await client
        .from("user_profiles")
        .select(
          "user_id, email, role, account_status, employee:employee_master(employee_name, department:department_master(department_name))",
        )
        .eq("user_id", next.user.id)
        .maybeSingle();
      setProfile(data as UserProfile | null);
      setLoading(false);
    };
    void client.auth.getSession().then(({ data }) => load(data.session));
    const { data } = client.auth.onAuthStateChange(
      (_event, next) => void load(next),
    );
    return () => data.subscription.unsubscribe();
  }, []);
  if (!isSupabaseConfigured)
    return (
      <StateCard
        title="接続設定が必要です"
        message="SupabaseのURLとanon keyを環境変数に設定してください。"
      />
    );
  if (loading)
    return (
      <StateCard
        title="アカウントを確認中"
        message="しばらくお待ちください。"
      />
    );
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route
          path="/login"
          element={
            session && canAccessMetering(profile) ? (
              <Navigate to="/" replace />
            ) : (
              <Login profile={profile} />
            )
          }
        />
        <Route
          path="/"
          element={
            session && canAccessMetering(profile) ? (
              <KanameterWorkspacePage
                profile={profile!}
                onSignOut={() => supabase!.auth.signOut()}
              />
            ) : session ? (
              <AccessDenied profile={profile} />
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

function Login({ profile }: { profile: UserProfile | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    const result = await supabase!.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setSubmitting(false);
    if (result.error) setError(result.error.message);
  };
  return (
    <main className="login-shell">
      <section className="login-visual">
        <div className="brand">
          <span>K</span>
          <strong>KANAMETER</strong>
        </div>
        <div>
          <p className="eyebrow">UTILITY OPERATIONS</p>
          <h1>
            検針データを
            <br />
            正確に、シンプルに。
          </h1>
          <p>
            契約条件をKANAMEと共有し、公共料金の入力・計算・確定を一か所で管理します。
          </p>
        </div>
        <small>KANAMETER</small>
      </section>
      <section className="login-form">
        <form onSubmit={submit}>
          <p className="eyebrow">SIGN IN</p>
          <h2>KANAMEアカウントでログイン</h2>
          <p className="muted">
            登録済みのメールアドレスとパスワードを使用します。
          </p>
          <label>
            メールアドレス
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </label>
          <label>
            パスワード
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {error && <p className="error">{error}</p>}
          {profile && !canAccessMetering(profile) && (
            <p className="error">
              このアカウントは検針アプリを利用できません。
            </p>
          )}
          <button className="primary" disabled={submitting}>
            {submitting ? "ログイン中…" : "ログイン"}
          </button>
        </form>
      </section>
    </main>
  );
}
function AccessDenied({ profile }: { profile: UserProfile | null }) {
  return (
    <StateCard
      title="利用権限がありません"
      message={
        profile?.account_status === "pending"
          ? "アカウントの承認待ちです。"
          : "管理者へお問い合わせください。"
      }
      action
    />
  );
}
function StateCard({
  title,
  message,
  action = false,
}: {
  title: string;
  message: string;
  action?: boolean;
}) {
  return (
    <main className="state-screen">
      <section>
        <div className="brand">
          <span>K</span>
          <strong>KANAMETER</strong>
        </div>
        <h1>{title}</h1>
        <p>{message}</p>
        {action && (
          <button
            className="secondary"
            onClick={() => supabase?.auth.signOut()}
          >
            ログアウト
          </button>
        )}
      </section>
    </main>
  );
}
