import { UserRole } from "~/lib/enum"
import { SettingLists } from "~/modules/settings/tabs/lists"
import { SettingsTitle } from "~/modules/settings/title"
import { defineSettingPageData } from "~/modules/settings/utils"

const iconName = "i-mgc-rada-cute-re"
const priority = 1050

export const loader = defineSettingPageData({
  iconName,
  name: "titles.lists",
  priority,
  hideIf: (ctx) => ctx.role === UserRole.Trial,
})

export function Component() {
  return (
    <>
      <SettingsTitle />
      <SettingLists />
    </>
  )
}
