import type { ReactNode } from "react";
import { MARKET_TABS, marketPath, type MarketTab } from "../../market";
import { navigate } from "../../router";
import { RailRow } from "../bits";

/** The market tabs as the `sm` rail; below it `PluginsSheet` draws a strip, and both read `MARKET_TABS`. */
export function MarketNav({ active }: { active: MarketTab }): ReactNode {
  return (
    <div className="py-1">
      {MARKET_TABS.map((tab) => (
        <RailRow
          key={tab.id}
          title={tab.title}
          active={tab.id === active}
          // `replace`: inside an overlay a sideways move must not add a Back entry.
          onClick={() => navigate(marketPath(tab.id), true)}
        />
      ))}
    </div>
  );
}
