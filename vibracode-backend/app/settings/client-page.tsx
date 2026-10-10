"use client";

import React, { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import { Route, Sparkles, Database, KeyRound, Check, X, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { CustomLoader } from "@/components/ui/custom-loader";
import { cn } from "@/lib/utils";

type ProviderName = "openrouter" | "mistral" | "gemini";

const PROVIDER_META: Record<ProviderName, { label: string; hint: string; icon: React.ElementType; keyField: "openrouterApiKey" | "mistralApiKey" | "geminiApiKey" }> = {
  openrouter: {
    label: "OpenRouter",
    hint: "sk-or-v1-... (models ending in :free cost nothing)",
    icon: Route,
    keyField: "openrouterApiKey",
  },
  mistral: {
    label: "Mistral AI",
    hint: "Paste your Mistral API key from console.mistral.ai",
    icon: Database,
    keyField: "mistralApiKey",
  },
  gemini: {
    label: "Google Gemini",
    hint: "AIza... from aistudio.google.com/apikey",
    icon: Sparkles,
    keyField: "geminiApiKey",
  },
};

export default function SettingsClientPage() {
  const { user, isSignedIn } = useUser();
  const router = useRouter();
  const shouldReduceMotion = useReducedMotion();

  const statuses = useQuery(
    api.providerSettings.getProviderSettings,
    isSignedIn ? { clerkId: user?.id } : "skip"
  );
  const saveSettings = useMutation(api.providerSettings.saveProviderSettings);

  const [keys, setKeys] = useState<Record<ProviderName, string>>({
    openrouter: "",
    mistral: "",
    gemini: "",
  });
  const [saving, setSaving] = useState<ProviderName | "all" | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isSignedIn) {
    return (
      <section className="flex flex-col h-screen bg-background items-center justify-center gap-4">
        <p className="text-muted-foreground">Please sign in to manage your provider settings.</p>
        <Button onClick={() => router.push("/sign-in")}>Sign in</Button>
      </section>
    );
  }

  if (!statuses) {
    return (
      <section className="flex flex-col h-screen bg-background">
        <CustomLoader text="Loading settings" className="h-full" />
      </section>
    );
  }

  const clerkId = user?.id as string;

  const handleSave = async (provider?: ProviderName) => {
    setSaving(provider ?? "all");
    setError(null);
    setSaved(false);
    const payload: {
      clerkId: string;
      openrouterApiKey?: string;
      mistralApiKey?: string;
      geminiApiKey?: string;
    } = { clerkId };

    if (provider) {
      payload[PROVIDER_META[provider].keyField] = keys[provider];
    } else {
      for (const name of ["openrouter", "mistral", "gemini"] as ProviderName[]) {
        if (keys[name]) payload[PROVIDER_META[name].keyField] = keys[name];
      }
    }

    try {
      await saveSettings(payload);
      setKeys({ openrouter: "", mistral: "", gemini: "" });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(null);
    }
  };

  const handleClear = async (provider: ProviderName) => {
    setSaving(provider);
    setError(null);
    try {
      await saveSettings({ clerkId, [PROVIDER_META[provider].keyField]: "" });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear key");
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="py-16 md:py-32 pt-20">
      <div className="mx-auto w-full max-w-3xl space-y-8 px-4">
        <motion.div
          initial={shouldReduceMotion ? false : { opacity: 0, translateY: -8 }}
          animate={{ opacity: 1, translateY: 0 }}
          transition={{ duration: shouldReduceMotion ? 0 : 0.4 }}
          className="text-center space-y-3"
        >
          <h2 className="text-3xl font-bold tracking-wide text-balance md:text-4xl lg:text-5xl xl:font-extrabold">
            Provider Settings
          </h2>
          <p className="text-muted-foreground text-sm tracking-wide text-balance md:text-base">
            Connect your own <b>OpenRouter</b>, <b>Mistral AI</b> and <b>Google Gemini</b> API keys.
            Keys are encrypted at rest, only ever shown masked, and override the server&apos;s
            default keys for your sessions.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 gap-4">
          {(Object.keys(PROVIDER_META) as ProviderName[]).map((name) => {
            const meta = PROVIDER_META[name];
            const status = statuses[name];
            const Icon = meta.icon;
            return (
              <Card key={name}>
                <CardHeader className="flex-row items-center justify-between space-y-0">
                  <div className="flex items-center gap-3">
                    <span className="p-2 rounded-lg bg-muted">
                      <Icon className="h-5 w-5" />
                    </span>
                    <div>
                      <CardTitle className="text-base">{meta.label}</CardTitle>
                      <CardDescription className="text-xs">{meta.hint}</CardDescription>
                    </div>
                  </div>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
                      status?.configured
                        ? "bg-emerald-500/10 text-emerald-600"
                        : "bg-muted text-muted-foreground"
                    )}
                  >
                    {status?.configured ? (
                      <>
                        <Check className="h-3 w-3" /> Configured {status.masked}
                      </>
                    ) : (
                      <>
                        <X className="h-3 w-3" /> Not configured
                      </>
                    )}
                  </span>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor={`key-${name}`} className="text-muted-foreground">
                      API key
                    </Label>
                    <div className="flex items-center gap-2">
                      <div className="relative flex-1">
                        <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          id={`key-${name}`}
                          type="password"
                          autoComplete="off"
                          placeholder={meta.hint}
                          value={keys[name]}
                          onChange={(e) =>
                            setKeys((prev) => ({ ...prev, [name]: e.target.value }))
                          }
                          className="pl-9"
                        />
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={saving === name || !keys[name]}
                        onClick={() => handleSave(name)}
                      >
                        {saving === name ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
                      </Button>
                    </div>
                  </div>
                  {status?.configured && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-muted-foreground hover:text-destructive"
                      disabled={saving === name}
                      onClick={() => handleClear(name)}
                    >
                      {saving === name ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <X className="h-3 w-3" />
                      )}
                      Clear key (fallback to server default)
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="space-y-3">
          {error && (
            <p className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">{error}</p>
          )}
          {saved && (
            <p className="text-sm text-emerald-600 bg-emerald-500/10 rounded-lg px-3 py-2">
              Settings saved successfully.
            </p>
          )}
          <Button
            type="button"
            className="w-full"
            disabled={saving === "all" || !Object.values(keys).some((v) => v)}
            onClick={() => handleSave()}
          >
            {saving === "all" ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Save all keys
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Empty fields are left untouched. Leave a field blank on save to keep the current key.
          </p>
        </div>
      </div>
    </section>
  );
}