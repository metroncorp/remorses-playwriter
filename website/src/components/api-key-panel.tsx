// Dashboard panel for managing API keys.
// Users can create keys (shown once), copy them, and revoke existing ones.
// API keys authenticate cloud browser requests via x-api-key header,
// as an alternative to the interactive `cloud login` device flow.
'use client'

import { useState } from 'react'
import { Button } from './ui/button.tsx'
import type { ApiKeyInfo } from '../db.ts'

/** Format epoch ms to a stable YYYY-MM-DD string that matches on server and client. */
function formatDate(epochMs: number): string {
  const d = new Date(epochMs)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

export function ApiKeyPanel({
  apiKeys,
  createAction,
  revokeAction,
}: {
  apiKeys: ApiKeyInfo[]
  createAction: (formData: FormData) => Promise<{ key: string }>
  revokeAction: (formData: FormData) => Promise<void>
}) {
  const [newKey, setNewKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [creating, setCreating] = useState(false)

  async function handleCreate(formData: FormData) {
    setCreating(true)
    try {
      const result = await createAction(formData)
      if (result?.key) {
        setNewKey(result.key)
        setCopied(false)
      }
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex w-full flex-col gap-5 rounded-xl border border-border bg-background p-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">API Keys</h2>
          <p className="text-sm text-muted-foreground">
            Use API keys for CI, VPS, or headless environments instead of <code className="text-xs">cloud login</code>.
          </p>
        </div>
      </div>

      {newKey && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
          <p className="mb-2 text-sm font-medium text-foreground">
            Your new API key (copy it now, it won't be shown again):
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-hidden text-ellipsis rounded bg-muted px-3 py-2 text-sm font-mono select-all">
              {newKey}
            </code>
            <Button
              variant="outline"
              onClick={() => {
                navigator.clipboard.writeText(newKey)
                setCopied(true)
              }}
            >
              {copied ? 'Copied!' : 'Copy'}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Set as <code>PLAYWRITER_API_KEY</code> environment variable.
          </p>
        </div>
      )}

      {apiKeys.length > 0 && (
        <div className="flex flex-col gap-2">
          {apiKeys.map((key) => {
            return (
              <div key={key.id} className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{key.name || 'Unnamed key'}</span>
                  <span className="text-xs text-muted-foreground font-mono">
                    {key.start || 'pw_'}•••
                    {' · '}
                    Created {formatDate(key.createdAt)}
                  </span>
                </div>
                <form action={revokeAction}>
                  <input type="hidden" name="keyId" value={key.id} />
                  <Button type="submit" variant="outline" className="text-destructive hover:text-destructive" loadingText="Revoking...">
                    Revoke
                  </Button>
                </form>
              </div>
            )
          })}
        </div>
      )}

      <form action={handleCreate}>
        <input type="hidden" name="name" value="Cloud API Key" />
        <Button type="submit" variant="outline" disabled={creating} loadingText="Creating...">
          {creating ? 'Creating...' : 'Create API key'}
        </Button>
      </form>
    </div>
  )
}
