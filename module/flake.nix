{
  description = "shrooms-board view module";

  inputs = {
    logos-module-builder.url = "github:logos-co/logos-module-builder/0.3.1";
    board_core.url = "path:../board_core";
    board_core.inputs.logos-module-builder.follows = "logos-module-builder";
  };

  outputs = inputs@{ logos-module-builder, ... }:
    logos-module-builder.lib.mkLogosQmlModule {
      src = ./.;
      configFile = ./metadata.json;
      flakeInputs = inputs;
    };
}
