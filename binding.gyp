{
    "targets": [
        {
            "target_name": "customlabels",
            "conditions": [
                ['target_arch == "x64"', {
                    "cflags": [
                        "-ftls-model=local-dynamic",
                        "-mtls-dialect=gnu2",
                        "-fPIC",
                        "-O3",
                        "-g",
                    ]
                }],
                ['target_arch == "arm64"', {
                    "cflags": [
                        "-ftls-model=local-dynamic",
                        "-fPIC",
                        "-O3",
                        "-g",
                    ]
                }],
            ],
            "sources": [
                "js/addon2.cpp",
                "src/customlabels.cpp",
                "src/hashmap.c"
            ],
        }
    ]
}
