import type { ReactNode } from "react";
import { MARKET_TABS, marketPath, type MarketTab } from "../../market";
import { navigate } from "../../router";
import { RailRow } from "../bits";

/**
 * The two tabs, as the rail beside the pane at `sm` and above.
 *
 * ⚠ **Rail-only, unlike `SettingsNav`, and that is the whole difference below
 * `sm`.** Settings has an index depth — `/settings` draws the section list and a
 * row drills into it — and the market has none: a tab *is* the content, so
 * `parseMarketRoute` answers `market` for a bare `/plugins` and there is no address
 * for a list. Inventing one would move that parser's pinned answers, `depthOf`'s
 * arms and `marketUp`'s parenthood, to buy a phone screen whose entire content is
 * two words. What the phone keeps instead is the heading-plus-one-link strip
 * `PluginsSheet` already drew, `sm:hidden`.
 *
 * ⚠ **Both that strip and this read `MARKET_TABS`**, so the two cannot drift in
 * order or in wording — which is the only thing that makes having two of them safe.
 *
 * No `state` and no `me`: every tab is offered to everybody, so there is nothing
 * here for `visibleSections`' counterpart to do, and no heading, so nothing for
 * `navRows`' either. That absence is why this is a sibling of `SettingsNav` rather
 * than a second caller of it.
 */
export function MarketNav({ active }: { active: MarketTab }): ReactNode {
  return (
    <div className="py-1">
      {MARKET_TABS.map((tab) => (
        <RailRow
          key={tab.id}
          title={tab.title}
          active={tab.id === active}
          /*
           * ⚠ **`replace`, matching the strip it doubles.** Switching tabs is
           * `depthOf` 1 → 1, so `navMove` answers `null` and nothing slides — and
           * inside an overlay anything that does not go deeper replaces, or
           * Android's Back walks the sheet sideways instead of popping out of it.
           */
          onClick={() => navigate(marketPath(tab.id), true)}
        />
      ))}
    </div>
  );
}
