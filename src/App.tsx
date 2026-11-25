import { useEffect, useState } from "react";
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
  const [error, setError] = useState(() =>
    new URLSearchParams(window.location.search).has("error")
      ? "Googleログインを完了できませんでした。@sk-housing.jp のアカウントを選択して再度お試しください。"
      : "",
  );
  const [submitting, setSubmitting] = useState(false);
  const signInWithGoogle = async () => {
    if (!supabase) {
      setError("Supabaseの接続情報が設定されていません。");
      return;
    }
    setSubmitting(true);
    setError("");
    const redirectUrl = new URL("login", new URL(import.meta.env.BASE_URL, window.location.origin));
    const { error: signInError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: redirectUrl.toString(),
        queryParams: { hd: "sk-housing.jp", prompt: "select_account" },
      },
    });
    if (signInError) {
      setSubmitting(false);
      setError("Googleログインを開始できませんでした。時間をおいて再度お試しください。");
    }
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
        <div className="login-form-content">
          <p className="eyebrow">SIGN IN</p>
          <h2>KANAMEアカウントでログイン</h2>
          <p className="muted">
            KANAMEと同じGoogle Workspaceアカウントを使用します。
          </p>
          {error && <p className="error">{error}</p>}
          {profile && !canAccessMetering(profile) && (
            <p className="error">
              このアカウントは検針アプリを利用できません。
            </p>
          )}
          <button className="primary google-login" type="button" onClick={() => void signInWithGoogle()} disabled={submitting}>
            {submitting ? "Googleへ接続中…" : <><GoogleMark />Googleアカウントでログイン</>}
          </button>
          <p className="login-note">@sk-housing.jp のGoogle Workspaceアカウントをご利用ください。</p>
        </div>
      </section>
    </main>
  );
}

function GoogleMark() {
  return <svg aria-hidden="true" viewBox="0 0 48 48" width="18" height="18"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.91c-.58 2.96-2.28 5.47-4.81 7.16l7.73 6C44.34 37.94 46.98 31.81 46.98 24.55Z"/><path fill="#FBBC05" d="M10.53 28.59A14.4 14.4 0 0 1 9.75 24c0-1.59.27-3.13.76-4.59l-7.98-6.19A23.9 23.9 0 0 0 0 24c0 3.87.93 7.54 2.56 10.78l7.97-6.19Z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.9-5.82l-7.73-6C30.02 37.91 27.26 39 24 39c-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 43.62 14.62 48 24 48Z"/></svg>;
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
