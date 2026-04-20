/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_EDGE_FUNCTIONS_BASE_URL: string;
  readonly VITE_REQUEST_OTP_URL: string;
  readonly VITE_VERIFY_OTP_URL: string;
  readonly VITE_PURCHASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
