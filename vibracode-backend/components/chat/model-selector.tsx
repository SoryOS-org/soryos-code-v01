"use client";

import { useState, useEffect } from "react";
import { ChevronDown, Check, Route, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  OPENROUTER_FREE_MODELS,
  GEMINI_MODELS,
  DEFAULT_AGENT_MODEL,
  type ModelOption,
} from "@/lib/models";

/**
 * Model id typed as a plain string: the catalog lives in lib/models.ts and is
 * shared with the iOS selector.
 */
export type ClaudeModel = string;

const ProviderIcon = ({ provider, className }: { provider: "openrouter" | "gemini"; className?: string }) =>
  provider === "gemini" ? (
    <Sparkles className={className} />
  ) : (
    <Route className={className} />
  );

const providerOf = (id: string): "openrouter" | "gemini" =>
  id.startsWith("gemini-") ? "gemini" : "openrouter";

const ALL_MODELS: ModelOption[] = [...OPENROUTER_FREE_MODELS, ...GEMINI_MODELS];

const nameOf = (id: string) => ALL_MODELS.find((m) => m.id === id)?.name || id;

interface ModelSelectorProps {
  value?: ClaudeModel;
  onChange?: (model: ClaudeModel) => void;
  disabled?: boolean;
  className?: string;
}

export function ModelSelector({
  value,
  onChange,
  disabled = false,
  className,
}: ModelSelectorProps) {
  const [selectedModel, setSelectedModel] = useState<ClaudeModel>(
    value || DEFAULT_AGENT_MODEL
  );

  useEffect(() => {
    // Load from localStorage on mount, ignoring ids that no longer exist
    const stored = localStorage.getItem("selectedClaudeModel");
    if (stored && ALL_MODELS.find((m) => m.id === stored)) {
      setSelectedModel(stored);
      onChange?.(stored);
    } else if (stored) {
      // Legacy Anthropic id -> migrate to the default free model
      setSelectedModel(DEFAULT_AGENT_MODEL);
      localStorage.setItem("selectedClaudeModel", DEFAULT_AGENT_MODEL);
      onChange?.(DEFAULT_AGENT_MODEL);
    }
  }, [onChange]);

  useEffect(() => {
    if (value) {
      setSelectedModel(value);
    }
  }, [value]);

  const handleSelect = (model: string) => {
    setSelectedModel(model);
    localStorage.setItem("selectedClaudeModel", model);
    onChange?.(model);
  };

  const renderItems = (models: ModelOption[]) =>
    models.map((model) => (
      <DropdownMenuItem
        key={model.id}
        onClick={() => handleSelect(model.id)}
        disabled={!model.tools}
        className={cn(
          "flex items-center gap-3 py-2",
          selectedModel === model.id && "bg-primary/10"
        )}
      >
        <ProviderIcon
          provider={providerOf(model.id)}
          className={cn(
            "h-4 w-4 shrink-0",
            selectedModel === model.id ? "text-primary" : "text-muted-foreground"
          )}
        />
        <div className="flex min-w-0 flex-col">
          <span
            className={cn(
              "truncate text-sm font-medium",
              selectedModel === model.id && "text-primary"
            )}
          >
            {model.name}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {model.description}
          </span>
        </div>
        {selectedModel === model.id && (
          <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />
        )}
      </DropdownMenuItem>
    ));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn(
            "h-8 gap-1.5 px-2 text-muted-foreground hover:text-foreground",
            className
          )}
        >
          <ProviderIcon provider={providerOf(selectedModel)} className="h-4 w-4" />
          <span className="max-w-[90px] truncate text-xs hidden sm:inline">
            {nameOf(selectedModel)}
          </span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 max-h-[420px] overflow-y-auto">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Route className="mr-2 h-4 w-4" />
            OpenRouter Free
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-[320px] overflow-y-auto">
            {renderItems(OPENROUTER_FREE_MODELS)}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Sparkles className="mr-2 h-4 w-4" />
            Google Gemini
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-[320px] overflow-y-auto">
            {renderItems(GEMINI_MODELS)}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          All models run on free tiers
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
