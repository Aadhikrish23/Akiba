import type { ApiClient } from '@akiba/api-client';
import { BrowserRouter, Link, Route, Routes } from 'react-router';
import { AuthProvider } from './auth/AuthContext';
import { AppShell } from './layout/AppShell';
import { ApiProvider } from './lib/api';
import { usePageTitle } from './lib/page';
import {
  ForgotPasswordPage,
  LoginPage,
  RegisterPage,
  ResetPasswordPage,
  VerifyEmailPage,
} from './pages/auth';
import { DiscoverPage } from './pages/Discover';
import { HomePage } from './pages/Home';
import { CurrentSeasonRedirect, SeasonChartPage } from './pages/SeasonChart';
import { TitlePage } from './pages/TitlePage';

function NotFoundPage() {
  usePageTitle('Page not found');
  return (
    <main id="main" className="mx-auto max-w-md" style={{ padding: '64px var(--gutter)' }}>
      <h1 className="font-serif text-2xl font-semibold">Page not found</h1>
      <p className="text-mute mt-2">There is nothing at this address.</p>
      <p className="mt-6">
        <Link to="/" className="underline underline-offset-4">
          Go to Akiba
        </Link>
      </p>
    </main>
  );
}

/** Every route of the app. Rendered inside a router by `App` (browser) and by the tests (memory). */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route path="discover" element={<DiscoverPage />} />
        <Route path="discover/season" element={<CurrentSeasonRedirect />} />
        <Route path="discover/season/:year/:season" element={<SeasonChartPage />} />
        <Route path="title/:titleId" element={<TitlePage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

export function App({ client }: { client: ApiClient }) {
  return (
    <ApiProvider client={client}>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </ApiProvider>
  );
}
