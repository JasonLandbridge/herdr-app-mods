import { View, div } from "gpui-kit";
import { openOverlay, props, theme } from "herdr";

export default class ProjectPresetsLauncher extends View {
  render() {
    const t = theme();
    const slot = props()?.slot ?? "sidebar";
    return div()
      .id(`pp-launch-${slot}`)
      .h(28)
      .px(8)
      .items_center()
      .justify_center()
      .cursor_pointer()
      .text_color("#9aa4b2")
      .hover((s) => s.bg("#202938").text_color("#f5f7fa"))
      .on_click(() => openOverlay({ mod: "sidebar-overhaul", kind: "popup", width: 1060, height: 0.8, props: { view: "project-presets" } }))
      .child("Projects");
  }
}
