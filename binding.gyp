{
    "targets": [
        {
            "target_name": "customlabels",
            "sources": [
                "js/addon.c",
                "js/addon_node.c",
                "src/customlabels.c"
            ],
            "cflags": [
                "-ftls-model=global-dynamic",
                "-mtls-dialect=desc",
                "-fPIC",
                "-O3",
                "-g"
            ]
        }
    ]
}
