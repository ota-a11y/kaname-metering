# KANAMETER

KANAMEから検針データ管理を業務機能として分離するための独立フロントエンドです。

## 現在の範囲

- KANAMEと同じSupabase Authでログイン
- `user_profiles.account_status = active` のユーザーを許可
- KANAMEでテナント請求対象にしたビルを表示
- ビルごとの公共料金単価設定を読み取り
- 契約区画ごとの基本料、項目単価、分類単価、丸め方式を読み取り

検針値は入力後に自動保存されます。「KANAMEに連携して確定」を実行すると対象月が確定済みとなり、以後の編集を停止します。

## ローカル起動

```powershell
Copy-Item .env.example .env.local
npm install
npm run dev
```

`.env.local` にKANAMEと同じSupabaseプロジェクトの情報を設定します。

## GitHub Pages

`main` ブランチへのpushでGitHub ActionsがPagesへデプロイします。Actions secretsに `VITE_SUPABASE_URL` と `VITE_SUPABASE_ANON_KEY` を登録します。

Supabase AuthenticationのRedirect URLsに `https://ota-a11y.github.io/kaname-metering/**` を追加します。

## 認可の将来拡張

現在のアプリ利用可否は `src/lib/access.ts` に集約しています。将来、検針アプリ用の許可テーブルまたはRPCに置き換えます。
