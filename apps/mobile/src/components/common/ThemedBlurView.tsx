import type { BlurViewProps } from "expo-blur"
import { BlurView } from "expo-blur"
import { useColorScheme } from "nativewind"
import { forwardRef } from "react"

export const ThemedBlurView = forwardRef<BlurView, BlurViewProps>(({ tint, ...rest }, ref) => {
  const { colorScheme } = useColorScheme()
  return (
    <BlurView
      ref={ref}
      tint={colorScheme === "light" ? "systemChromeMaterialLight" : "systemChromeMaterialDark"}
      {...rest}
    />
  )
})
