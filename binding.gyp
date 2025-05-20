{
    "targets": [
        {
            "target_name": "customlabels",
            "conditions": [
                ['target_arch == "x64"', {
                    "cflags": [
                        "-ftls-model=global-dynamic",
                        "-mtls-dialect=gnu2",
                        "-fPIC",
                        "-O3",
                        "-g"
                    ]
                }],
                ['target_arch == "arm64"', {
                    "cflags": [
                        "-ftls-model=global-dynamic",
                        "-mtls-dialect=desc",
                        "-fPIC",
                        "-O3",
                        "-g"
                    ]
                }],
            ],
            "sources": [
                "js/addon.c",
                "js/addon_node.c",
                "src/customlabels.c"
            ],
        }
    ]
}
