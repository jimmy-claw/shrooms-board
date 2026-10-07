{
  description = "shrooms-board core module";

  inputs = {
    # pinned to the release tag: branches are volatile, tags are stable
    logos-module-builder.url = "github:logos-co/logos-module-builder/0.3.1";
  };

  outputs = inputs@{ logos-module-builder, ... }:
    logos-module-builder.lib.mkLogosModule {
      src = ./.;
      configFile = ./metadata.json;
      flakeInputs = inputs;
    };
}
