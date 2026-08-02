import { fetchFirmwareIndex } from '@/lib/firmware';
import { handleErrors, json } from '@/lib/http';

// Release index for the Get Started / Update panels. Same shape the old
// GitHub Pages firmware/index.json carried, but built live from the GitHub
// releases API with proxy paths for the assets.
export async function GET(): Promise<Response> {
    return handleErrors(async () => {
        const entries = await fetchFirmwareIndex();
        const response = json(entries);
        response.headers.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
        return response;
    });
}
