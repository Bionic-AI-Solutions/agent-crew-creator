/**
 * Option list for LiveVoicePicker, kept pure so it can be tested without
 * rendering Radix Select.
 *
 * The current value must always be among the rendered items, or the Select
 * trigger goes blank the moment the search box filters it out. So it is
 * prepended whenever the filter hides it: as the real entry when the
 * provider lists it, and as a labelled placeholder when it does not. The
 * label is judged against the full list, never the filtered one, so typing
 * in the search box cannot relabel a valid selection. Agents saved while the
 * STT picker listed TTS voices hold a voice name here; without the label it
 * looked like a legitimate model.
 */
export interface PickerVoice {
  id: string;
  name?: string;
  description?: string;
  language?: string;
}

export function pickerOptions(
  voices: PickerVoice[],
  filter: string,
  value: string,
  missingLabel: string,
): PickerVoice[] {
  const needle = filter.toLowerCase();
  const filtered = filter
    ? voices.filter((v) => `${v.id} ${v.name || ""} ${v.description || ""}`.toLowerCase().includes(needle))
    : voices;
  if (!value || filtered.some((v) => v.id === value)) return filtered;
  const current = voices.find((v) => v.id === value);
  return [current ?? { id: value, description: missingLabel }, ...filtered];
}
