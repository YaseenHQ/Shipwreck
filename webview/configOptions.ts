import type { ConfigOptionInfo } from "../src/types";

export interface ComposerConfig {
  /** First select categorized "mode" — drives the mode pill via setConfigOption. */
  primaryMode?: ConfigOptionInfo;
  /** First select categorized "model". */
  primaryModel?: ConfigOptionInfo;
  /** First select categorized "thought_level". */
  primaryThought?: ConfigOptionInfo;
  /** The three primary options in original agent array order. */
  primaryPills: ConfigOptionInfo[];
  /** All model_config options (select or boolean). */
  modelParameters: ConfigOptionInfo[];
  /** A two-way "plan first" switch some agents send next to their mode (category collaboration_mode). */
  planToggle?: PlanToggle;
  /** Options not covered by the mode control or model picker. */
  traits: ConfigOptionInfo[];
  /** Legacy session modes are only used when the agent sent no config options. */
  useLegacyModes: boolean;
}

export interface PlanToggle {
  option: ConfigOptionInfo;
  planValue: string;
  offValue: string;
  on: boolean;
}

function planToggleOf(o: ConfigOptionInfo | undefined): PlanToggle | undefined {
  const opts = o?.options ?? [];
  if (!o || opts.length !== 2) return undefined;
  const plan = opts.find((x) => /plan/i.test(`${x.value} ${x.name}`));
  const off = opts.find((x) => x !== plan);
  if (!plan || !off) return undefined;
  return { option: o, planValue: plan.value, offValue: off.value, on: String(o.currentValue) === plan.value };
}

export function getComposerConfig(
  options: readonly ConfigOptionInfo[],
  hasLegacyModes: boolean,
): ComposerConfig {
  const selects = options.filter((o) => o.type === "select");
  const primaryMode = selects.find((o) => o.category === "mode");
  const primaryModel = selects.find((o) => o.category === "model");
  const primaryThought = selects.find((o) => o.category === "thought_level");
  const planToggle = planToggleOf(selects.find((o) => o.category === "collaboration_mode"));
  const primaryPills = [primaryMode, primaryModel, primaryThought]
    .filter((o): o is ConfigOptionInfo => !!o)
    .sort((a, b) => options.indexOf(a) - options.indexOf(b));
  return {
    primaryMode,
    primaryModel,
    primaryThought,
    primaryPills,
    modelParameters: options.filter((o) => o.category === "model_config"),
    planToggle,
    traits: options.filter(
      (o) =>
        o !== primaryMode && o !== primaryModel && o !== primaryThought && o !== planToggle?.option,
    ),
    useLegacyModes: options.length === 0 && hasLegacyModes,
  };
}
