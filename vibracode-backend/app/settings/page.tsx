import { Metadata } from "next";
import SettingsClientPage from "./client-page";

export const metadata: Metadata = {
  title: "Provider Settings | Vibra Code",
  description: "Manage your AI provider API keys (OpenRouter, Mistral, Gemini)",
};

export default async function SettingsPage() {
  return <SettingsClientPage />;
}