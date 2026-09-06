import { AuthProvider } from "../lib/useAuth";
import "../styles/globals.css";

export default function App({ Component, pageProps }) {
  return (
    <AuthProvider>
      <Component {...pageProps} />
    </AuthProvider>
  );
}
