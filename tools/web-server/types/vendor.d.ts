// plotly.js-dist-min is the prebuilt bundle; it ships no types, so alias it
// to the full plotly.js types.
declare module 'plotly.js-dist-min' {
    import type Plotly from 'plotly.js';

    export = Plotly;
}

// esp-web-tools custom element used by the Get Started panel.
declare namespace React.JSX {
    interface IntrinsicElements {
        'esp-web-install-button': React.DetailedHTMLProps<
            React.HTMLAttributes<HTMLElement> & { manifest?: string },
            HTMLElement
        >;
    }
}
