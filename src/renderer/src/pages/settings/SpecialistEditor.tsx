import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  deriveSpecialistName,
  validateCreateSpecialistInput,
  type CreateSpecialistInput,
  type SpecialistFieldError
} from '../../../../shared/specialist'

type SpecialistEditorProps = {
  onCancel: () => void
  onSave: (input: CreateSpecialistInput) => Promise<void>
  existingNames?: string[]
}

type FormState = {
  displayName: string
  name: string
  description: string
  systemPrompt: string
  iconKey: string
  colorKey: string
  // Whether name was manually edited (if so, stop auto-deriving)
  nameTouched: boolean
}

const ICON_OPTIONS = [
  { key: 'brain', label: 'Brain' },
  { key: 'beaker', label: 'Beaker' },
  { key: 'book-open', label: 'Book' },
  { key: 'flask-conical', label: 'Flask' },
  { key: 'microscope', label: 'Microscope' },
  { key: 'search', label: 'Search' }
] as const

const COLOR_OPTIONS = [
  { key: 'blue', label: 'Blue' },
  { key: 'green', label: 'Green' },
  { key: 'teal', label: 'Teal' },
  { key: 'amber', label: 'Amber' },
  { key: 'purple', label: 'Purple' },
  { key: 'slate', label: 'Slate' }
] as const

const SpecialistEditor = ({
  onCancel,
  onSave,
  existingNames = []
}: SpecialistEditorProps): React.JSX.Element => {
  const [form, setForm] = useState<FormState>({
    displayName: '',
    name: '',
    description: '',
    systemPrompt: '',
    iconKey: 'brain',
    colorKey: 'purple',
    nameTouched: false
  })
  const [fieldErrors, setFieldErrors] = useState<SpecialistFieldError[]>([])
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>()

  // Derived during render: the name follows displayName until manually edited.
  const effectiveName = form.nameTouched ? form.name : deriveSpecialistName(form.displayName)

  const getFieldError = (field: SpecialistFieldError['field']): string | undefined =>
    fieldErrors.find((e) => e.field === field)?.message

  const validate = (): boolean => {
    // Client-side validation using the shared validator.
    const input: CreateSpecialistInput = {
      displayName: form.displayName,
      name: effectiveName || undefined,
      description: form.description || undefined,
      systemPrompt: form.systemPrompt || undefined
    }
    const errors = validateCreateSpecialistInput(input, existingNames)
    setFieldErrors(errors)
    return errors.length === 0
  }

  const handleSave = async (): Promise<void> => {
    if (!validate()) return

    setIsSaving(true)
    setSaveError(undefined)
    try {
      const input: CreateSpecialistInput = {
        displayName: form.displayName.trim(),
        name: effectiveName.trim() || undefined,
        description: form.description.trim() || undefined,
        systemPrompt: form.systemPrompt.trim() || undefined,
        iconKey: form.iconKey,
        colorKey: form.colorKey
      }
      await onSave(input)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not create specialist.')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="p-5">
      <div className="max-w-2xl">
        {/* Identity section */}
        <section className="mb-6">
          <h3 className="mb-1 text-base font-semibold text-foreground">Identity</h3>
          <p className="mb-4 text-[13px] leading-5 text-muted-foreground">
            How this specialist appears in the registry and session picker.
          </p>

          {/* Display name */}
          <div className="mb-4">
            <label htmlFor="sp-display-name" className="mb-1.5 block text-xs font-semibold">
              Display name
            </label>
            <Input
              id="sp-display-name"
              value={form.displayName}
              onChange={(e) => {
                setForm((prev) => ({ ...prev, displayName: e.target.value }))
                setFieldErrors((prev) => prev.filter((er) => er.field !== 'displayName'))
              }}
              placeholder="e.g. RNA-seq Reviewer"
              aria-describedby={getFieldError('displayName') ? 'sp-display-name-err' : undefined}
              aria-invalid={!!getFieldError('displayName')}
              className={cn(getFieldError('displayName') && 'border-destructive')}
            />
            {getFieldError('displayName') ? (
              <p id="sp-display-name-err" className="mt-1 text-xs text-destructive" role="alert">
                {getFieldError('displayName')}
              </p>
            ) : null}
          </div>

          {/* Public name (UPPER_SNAKE) */}
          <div className="mb-4">
            <label htmlFor="sp-name" className="mb-1.5 block text-xs font-semibold">
              Public name
            </label>
            <Input
              id="sp-name"
              value={effectiveName}
              onChange={(e) => {
                setForm((prev) => ({
                  ...prev,
                  name: e.target.value.toUpperCase(),
                  nameTouched: true
                }))
                setFieldErrors((prev) => prev.filter((er) => er.field !== 'name'))
              }}
              placeholder="RNA_SEQ_REVIEWER"
              className={cn('font-mono text-[13px]', getFieldError('name') && 'border-destructive')}
              aria-describedby="sp-name-hint sp-name-err"
              aria-invalid={!!getFieldError('name')}
            />
            <p id="sp-name-hint" className="mt-1 text-[11px] text-muted-foreground">
              Used in logs and the SDK. Auto-derived from display name; editable before saving.
            </p>
            {getFieldError('name') ? (
              <p id="sp-name-err" className="mt-1 text-xs text-destructive" role="alert">
                {getFieldError('name')}
              </p>
            ) : null}
          </div>

          {/* Description */}
          <div className="mb-0">
            <label htmlFor="sp-description" className="mb-1.5 block text-xs font-semibold">
              Description <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <Input
              id="sp-description"
              value={form.description}
              onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
              placeholder="Short description shown in the list and picker"
            />
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-semibold">Icon</label>
              <Select
                value={form.iconKey}
                onValueChange={(iconKey) => setForm((prev) => ({ ...prev, iconKey }))}
              >
                <SelectTrigger aria-label="Specialist icon">
                  <span>{ICON_OPTIONS.find((option) => option.key === form.iconKey)?.label}</span>
                </SelectTrigger>
                <SelectContent>
                  {ICON_OPTIONS.map((option) => (
                    <SelectItem key={option.key} value={option.key}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold">Color</label>
              <Select
                value={form.colorKey}
                onValueChange={(colorKey) => setForm((prev) => ({ ...prev, colorKey }))}
              >
                <SelectTrigger aria-label="Specialist color">
                  <span>{COLOR_OPTIONS.find((option) => option.key === form.colorKey)?.label}</span>
                </SelectTrigger>
                <SelectContent>
                  {COLOR_OPTIONS.map((option) => (
                    <SelectItem key={option.key} value={option.key}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </section>

        {/* Instructions section */}
        <section className="mb-6 border-t border-border pt-5">
          <h3 className="mb-1 text-base font-semibold text-foreground">Instructions</h3>
          <p className="mb-4 text-[13px] leading-5 text-muted-foreground">
            Appended to the app&rsquo;s base prompt — does not replace safety rules or tool
            instructions. Optional.
          </p>
          <div>
            <label htmlFor="sp-system-prompt" className="sr-only">
              Instructions
            </label>
            <Textarea
              id="sp-system-prompt"
              value={form.systemPrompt}
              onChange={(e) => setForm((prev) => ({ ...prev, systemPrompt: e.target.value }))}
              placeholder="Optional — leave empty to use the base prompt as-is."
              className="min-h-[120px] resize-y text-[13px]"
            />
          </div>
        </section>

        {/* Capabilities section (mode only — detail config deferred) */}
        <section className="border-t border-border pt-5">
          <h3 className="mb-1 text-base font-semibold text-foreground">Capabilities</h3>
          <p className="text-[13px] leading-5 text-muted-foreground">
            This specialist will start with <strong>Full access</strong> — all current and future
            Skills and Connectors included by default. You can configure exclusions and per-tool
            rules after saving.
          </p>
        </section>

        {/* Save error */}
        {saveError ? (
          <p className="mt-4 text-sm text-destructive" role="alert">
            {saveError}
          </p>
        ) : null}

        {/* Footer actions */}
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSave()}
            disabled={isSaving || !form.displayName.trim()}
          >
            {isSaving ? 'Creating…' : 'Create specialist'}
          </Button>
        </div>
      </div>
    </div>
  )
}

export { SpecialistEditor }
