// Metro bundles an imported image as an asset and hands back its source.
declare module "*.webp" {
  import type { ImageSourcePropType } from "react-native";

  const source: ImageSourcePropType;
  export default source;
}
