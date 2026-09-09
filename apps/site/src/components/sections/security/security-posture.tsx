import { getTranslations } from "next-intl/server";

export async function SecurityPosture() {
  const t = await getTranslations("security.posture");
  const defendItems = t.raw("defend.items") as string[];
  const dontItems = t.raw("dont.items") as string[];

  return (
    <section
      id="posture"
      className="container-content grid grid-cols-1 gap-10 py-(--spacing-section) sm:grid-cols-2 sm:gap-12"
    >
      <div>
        <h2 className="mb-5 text-[clamp(1.25rem,2.2vw,1.5625rem)] leading-[1.06]">
          {t("defend.title")}
        </h2>
        <ul className="grid gap-3 text-[1rem] leading-[1.7] text-text-muted">
          {defendItems.map((item) => (
            <li key={item} className="flex gap-3">
              <span aria-hidden="true" className="text-brand">
                ✓
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h2 className="mb-5 text-[clamp(1.25rem,2.2vw,1.5625rem)] leading-[1.06]">
          {t("dont.title")}
        </h2>
        <ul className="grid gap-3 text-[1rem] leading-[1.7] text-text-muted">
          {dontItems.map((item) => (
            <li key={item} className="flex gap-3">
              <span aria-hidden="true" className="text-signal-blocked">
                !
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
